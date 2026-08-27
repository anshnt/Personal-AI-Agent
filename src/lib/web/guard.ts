import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Outbound HTTP for URLs the model chose.
 *
 * A model-supplied URL is an SSRF vector, and the payoff for an attacker is
 * high: `169.254.169.254` returns cloud instance credentials, and `localhost`
 * reaches this application's own database and any other service on the host.
 * A page the agent fetched can also *contain* the next URL, so a single
 * injected link is enough to try.
 *
 * The defence has four parts, and each closes a hole the others leave open:
 *
 * 1. Scheme and port allowlists, so `file://` and `gopher://` never start.
 * 2. DNS resolution up front, with every returned address classified against
 *    the private, loopback, link-local and reserved ranges.
 * 3. The socket is pinned to an address that passed step 2, via a custom
 *    `lookup`. Validating DNS and then calling `fetch` leaves a rebinding
 *    window: the name can resolve to a public address for the check and a
 *    private one microseconds later for the connection. Pinning removes it.
 * 4. Redirects are followed manually, and every hop repeats steps 1 to 3.
 *    Letting the HTTP client follow them would skip all of the above.
 *
 * Size, time, and content-type limits are enforced while streaming, so a
 * malicious server cannot exhaust memory by promising a small body.
 */

export class UnsafeUrlError extends Error {}
export class FetchFailedError extends Error {}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
/** Standard web ports only. Anything else is a service, not a web page. */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

const MAX_REDIRECTS = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/**
 * Hosts the operator has explicitly opted into, bypassing the private-address
 * refusal.
 *
 * A self-hosted SearXNG on `127.0.0.1:8888`, or a NAS at `192.168.1.10`, are
 * legitimate targets — but only because a human said so. Matching is exact on
 * `host` or `host:port`, never a suffix: a suffix match would let
 * `evil-127.0.0.1.attacker.example` through.
 */
function allowedHosts(): Set<string> {
  const raw = process.env.WEB_FETCH_ALLOW_HOSTS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function isOperatorAllowed(url: URL): boolean {
  const hosts = allowedHosts();
  if (hosts.size === 0) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return hosts.has(url.host.toLowerCase()) || hosts.has(hostname);
}

const TEXTUAL_CONTENT = [
  'text/html',
  'text/plain',
  'text/markdown',
  'application/xhtml+xml',
  'application/json',
  'application/xml',
  'text/xml',
  'application/ld+json',
];

/* -------------------------------------------------------------------------- */
/* Address classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * True when an address must never be connected to.
 *
 * Covers more than the three RFC 1918 ranges people usually remember:
 * link-local carries every major cloud's metadata service, carrier-grade NAT
 * (100.64/10) reaches other tenants on some networks, and the IPv4-mapped IPv6
 * form (`::ffff:127.0.0.1`) is a standard way to smuggle a v4 address past a
 * v4-only check.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedV4(address);
  if (version === 6) return isBlockedV6(address);
  // Not an IP literal at all: never treat it as safe.
  return true;
}

function isBlockedV4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;

  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol, 192.0.2.0/24 test
  if (a === 192 && b === 88) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? '';

  if (lower === '::' || lower === '::1') return true;

  // An IPv4-mapped address is an IPv4 destination wearing a v6 costume.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  // The hex form of the same thing, ::ffff:7f00:1.
  if (lower.startsWith('::ffff:')) return true;

  // fc00::/7 unique local, fe00::/9 reserved, fe80::/10 link-local,
  // fec0::/10 site-local (deprecated but still routed on some networks), and
  // ff00::/8 multicast all sit under these four prefixes. Enumerating the
  // nibbles individually is how fec0:: got missed the first time.
  if (/^f[cdef]/.test(lower)) return true;
  if (lower.startsWith('64:ff9b:')) return true; // NAT64
  if (lower.startsWith('100:')) return true; // discard-only
  if (lower.startsWith('2001:db8')) return true; // documentation

  return false;
}

/* -------------------------------------------------------------------------- */
/* URL validation                                                             */
/* -------------------------------------------------------------------------- */

export interface ValidatedTarget {
  url: URL;
  /** The address the socket will be pinned to. */
  address: string;
  family: 4 | 6;
}

/**
 * The synchronous half of validation: everything decidable from the URL text.
 *
 * Split out from `validateTarget` because these are the checks worth running on
 * a list of search results. A DNS lookup per result would add a round trip each
 * and, worse, would drop a perfectly good result because a resolver hiccuped.
 * The full check still runs before anything is actually fetched, so nothing is
 * lost by screening cheaply first.
 */
export function screenUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError(`"${raw}" is not a valid URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeUrlError(`Only http and https are allowed, not ${url.protocol}`);
  }

  if (url.username.length > 0 || url.password.length > 0) {
    // Credentials in a URL are a classic way to make a hostile host look
    // familiar: https://www.google.com@attacker.example/
    throw new UnsafeUrlError('URLs with embedded credentials are not allowed.');
  }

  const operatorAllowed = isOperatorAllowed(url);

  const port =
    url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10);
  if (!operatorAllowed && !ALLOWED_PORTS.has(port)) {
    throw new UnsafeUrlError(`Port ${port} is not allowed. Only 80, 443, 8080 and 8443 are.`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.length === 0) {
    throw new UnsafeUrlError('That URL has no host.');
  }

  if (operatorAllowed) return url;

  // An IP literal needs no DNS, so it is fully decidable here.
  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw new UnsafeUrlError(`${hostname} is a private or reserved address.`);
  }

  // `.localhost` and friends are reserved names for the loopback interface, and
  // some resolvers answer them without consulting DNS at all.
  if (/(^|\.)(localhost|local|internal|localdomain)$/i.test(hostname)) {
    throw new UnsafeUrlError(`${hostname} refers to this machine or a local network.`);
  }

  return url;
}

/**
 * The full check: screen the URL text, then resolve it and validate every
 * address DNS returns.
 */
export async function validateTarget(raw: string): Promise<ValidatedTarget> {
  const url = screenUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const operatorAllowed = isOperatorAllowed(url);

  // An IP literal was already range-checked by `screenUrl`; there is nothing
  // for DNS to tell us.
  if (isIP(hostname) !== 0) {
    return { url, address: hostname, family: isIP(hostname) === 6 ? 6 : 4 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve ${hostname}.`);
  }

  const chosen = addresses[0];
  if (!chosen) {
    throw new UnsafeUrlError(`${hostname} did not resolve to any address.`);
  }

  if (!operatorAllowed) {
    // Every answer must be safe, not just the one that gets used. A name that
    // resolves to both a public and a private address is a rebinding setup.
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        throw new UnsafeUrlError(
          `${hostname} resolves to ${entry.address}, which is a private or reserved address.`,
        );
      }
    }
  }

  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

export interface SafeResponse {
  /** The URL actually fetched, after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: string[];
}

export interface SafeFetchOptions {
  /** Sent as-is. Kept identifiable rather than pretending to be a browser. */
  userAgent?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Accept non-textual responses. Off by default. */
  allowAnyContentType?: boolean;
}

/**
 * Fetch a URL, validating every hop.
 *
 * Node's low-level `request` is used rather than `fetch` for one reason: it
 * accepts a custom `lookup`, which is what lets the socket be pinned to an
 * already-validated address. There is no equivalent hook on `fetch`, so a
 * `fetch`-based implementation cannot close the DNS rebinding window.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const userAgent = options.userAgent ?? 'PersonalAgent/1.0 (+https://github.com/anshnt/Personal-AI-Agent)';

  const redirects: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-validated on every hop: a 302 to 169.254.169.254 is the whole attack.
    const target = await validateTarget(current);
    const response = await requestOnce(target, { userAgent, timeoutMs });

    const location = response.headers.location;
    if (
      response.statusCode !== undefined &&
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      typeof location === 'string'
    ) {
      response.resume(); // Drain so the socket can be reused or closed.
      if (hop === MAX_REDIRECTS) {
        throw new FetchFailedError(`Too many redirects (stopped at ${MAX_REDIRECTS}).`);
      }
      const next = new URL(location, target.url).toString();
      redirects.push(next);
      current = next;
      continue;
    }

    const status = response.statusCode ?? 0;
    const contentType = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

    if (!options.allowAnyContentType && contentType.length > 0) {
      if (!TEXTUAL_CONTENT.includes(contentType)) {
        response.destroy();
        throw new FetchFailedError(
          `${current} returned ${contentType}, which is not readable text.`,
        );
      }
    }

    const { text, truncated } = await readBody(response, maxBytes);

    return {
      finalUrl: current,
      status,
      contentType,
      body: text,
      truncated,
      redirects,
    };
  }

  throw new FetchFailedError('Too many redirects.');
}

function requestOnce(
  target: ValidatedTarget,
  options: { userAgent: string; timeoutMs: number },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = target.url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    let settled = false;
    const request: ClientRequest = send(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname.replace(/^\[|\]$/g, ''),
        port: target.url.port || (isHttps ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        headers: {
          // The real hostname is still sent, so virtual hosting and TLS SNI
          // work; only the address the socket dials is pinned.
          host: target.url.host,
          'user-agent': options.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding': 'identity',
        },
        // This is the pin. The address was validated moments ago and DNS is not
        // consulted again, so the name cannot be re-pointed under us.
        lookup: pinnedLookup(target.address, target.family),
        timeout: options.timeoutMs,
      },
      (response) => {
        settled = true;
        resolve(response);
      },
    );

    request.on('timeout', () => {
      request.destroy(new FetchFailedError(`${target.url.href} timed out.`));
    });

    request.on('error', (error: Error) => {
      if (settled) return;
      reject(
        error instanceof FetchFailedError
          ? error
          : new FetchFailedError(`Could not reach ${target.url.href}: ${error.message}`),
      );
    });

    request.end();
  });
}

/**
 * Read a response body with a hard byte ceiling.
 *
 * The cap is enforced on bytes as they arrive rather than on `Content-Length`,
 * because a hostile server can under-report or omit it entirely.
 */
function readBody(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;

    response.on('data', (chunk: Buffer) => {
      if (truncated) return;
      total += chunk.length;
      if (total > maxBytes) {
        truncated = true;
        const keep = maxBytes - (total - chunk.length);
        if (keep > 0) chunks.push(chunk.subarray(0, keep));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });

    response.on('end', () => {
      resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    });

    response.on('close', () => {
      // Destroying the stream at the cap fires `close` without `end`.
      if (truncated) resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    });

    response.on('error', (error: Error) => {
      if (truncated) return;
      reject(new FetchFailedError(`Read failed: ${error.message}`));
    });
  });
}

/**
 * A `lookup` implementation that always answers with one pre-validated address.
 *
 * Node calls `lookup` with `{ all: true }`, in which case the callback takes an
 * *array* of `{ address, family }`; the three-argument form is only used when
 * `all` is false. Answering in the wrong shape fails with
 * "Invalid IP address: undefined", so both are handled.
 */
function pinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (...args: never[]) => void,
  ): void => {
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;
    const done = callback as unknown as (
      error: NodeJS.ErrnoException | null,
      addresses: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;

    if (wantsAll) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}
