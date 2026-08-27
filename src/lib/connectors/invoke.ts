import { request as httpsRequest } from 'node:https';

import { validateTarget } from '@/lib/web/guard';
import { consume, refund } from './limiter';
import { findConnector, isConfigured } from './registry';
import {
  ConnectorError,
  type ConnectorDefinition,
  type InvokeResult,
  type OperationDefinition,
} from './types';

export interface InvokeOptions {
  userId: string;
  connector: string;
  operation: string;
  params: Record<string, unknown>;
  /**
   * Set only when the user has actually asked for the write.
   *
   * A mutating operation is refused without it, so text the agent read — a web
   * page, an email — cannot cause an outward-facing action on its own.
   */
  confirmedByUser?: boolean;
}

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Call a declared operation on a declared connector.
 *
 * The order of operations matters: validate, then rate-limit, then resolve the
 * credential, then build the request. Nothing reaches the network until the
 * parameters have been checked against the operation's schema, and the
 * credential is read at the last moment and never returned.
 */
export async function invoke(options: InvokeOptions): Promise<InvokeResult> {
  const connector = findConnector(options.connector);
  if (!connector) {
    throw new ConnectorError(`There is no connector called "${options.connector}".`);
  }

  if (!isConfigured(connector)) {
    throw new ConnectorError(
      connector.setupHint
        ? `The ${connector.name} connector is not set up. ${connector.setupHint}`
        : `The ${connector.name} connector is not set up.`,
    );
  }

  const operation = connector.operations.find((entry) => entry.name === options.operation);
  if (!operation) {
    throw new ConnectorError(
      `"${options.operation}" is not an operation on ${connector.name}. Available: ${connector.operations
        .map((entry) => entry.name)
        .join(', ')}.`,
    );
  }

  if (operation.mutates && options.confirmedByUser !== true) {
    throw new ConnectorError(
      `${connector.name}.${operation.name} changes something outside this app, so it needs the user to have asked for it. Confirm with them, then call again with confirmed_by_user set.`,
    );
  }

  const parsed = operation.input.safeParse(options.params);
  if (!parsed.success) {
    // The expected shape is echoed back so the model can correct itself in one
    // step rather than guessing at what was wrong.
    throw new ConnectorError(
      `Those parameters are not valid for ${connector.name}.${operation.name}: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
        .join('; ')}`,
    );
  }

  const verdict = await consume(options.userId, connector.name, connector.rateLimit);
  if (!verdict.allowed) {
    throw new ConnectorError(
      `Rate limit reached for ${connector.name}: ${connector.rateLimit.calls} calls per ${
        connector.rateLimit.windowSeconds / 60
      } minutes. Resets at ${verdict.resetAt.toISOString()}.`,
    );
  }

  try {
    const { url, body, headers } = buildRequest(connector, operation, parsed.data);

    // The same guard the web tools use. A connector base URL is configuration,
    // and a custom connector's base comes from an operator-supplied string, so
    // it gets validated like any other outbound target.
    const target = await validateTarget(url.toString());

    const response = await send(target.url, target.address, target.family, {
      method: operation.method,
      headers,
      body,
    });

    if (response.status >= 400) {
      throw new ConnectorError(
        `${connector.name}.${operation.name} returned ${response.status}: ${redact(
          response.text.slice(0, 500),
          connector,
        )}`,
      );
    }

    const data = parseBody(response.text);
    const summarised = operation.summarise ? operation.summarise(data) : data;

    return {
      connector: connector.name,
      operation: operation.name,
      status: response.status,
      // Belt and braces: a service that echoes its own auth header back, or a
      // custom connector that puts the key in a query string, must not put the
      // credential into the model's context.
      data: redactDeep(summarised, connector),
      remaining: verdict.remaining,
    };
  } catch (error) {
    // A call that never went out should not count against the limit.
    if (error instanceof ConnectorError && error.message.startsWith('Rate limit')) throw error;
    await refund(options.userId, connector.name, connector.rateLimit.windowSeconds).catch(() => {
      // A failed refund is not worth surfacing over the original error.
    });
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Request construction                                                       */
/* -------------------------------------------------------------------------- */

interface BuiltRequest {
  url: URL;
  body?: string;
  headers: Record<string, string>;
}

function buildRequest(
  connector: ConnectorDefinition,
  operation: OperationDefinition,
  params: Record<string, unknown>,
): BuiltRequest {
  const consumed = new Set<string>();

  // Path placeholders are percent-encoded, so a parameter value can never add a
  // path segment or escape the operation's declared path.
  const path = operation.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new ConnectorError(`${operation.name} needs the parameter "${name}".`);
    }
    consumed.add(name);
    return encodeURIComponent(String(value));
  });

  const url = new URL(path.replace(/^\//, ''), ensureTrailingSlash(connector.baseUrl));

  const queryNames = new Set(operation.query ?? []);
  const bodyFields: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(params)) {
    if (consumed.has(name) || value === undefined) continue;

    if (queryNames.has(name) || operation.method === 'GET') {
      // A GET has no body, so anything left over has to be a query parameter.
      url.searchParams.set(name, String(value));
    } else {
      bodyFields[name] = value;
    }
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'PersonalAgent/1.0',
  };

  const body =
    operation.method === 'POST' && Object.keys(bodyFields).length > 0
      ? JSON.stringify(bodyFields)
      : undefined;
  if (body !== undefined) headers['content-type'] = 'application/json';

  applyAuth(connector, url, headers);

  return { url, body, headers };
}

/**
 * Attach the credential.
 *
 * Read from the environment here, at the last moment, and written only into the
 * outgoing request. It is never stored, never returned, and never part of
 * anything the model sees.
 */
function applyAuth(
  connector: ConnectorDefinition,
  url: URL,
  headers: Record<string, string>,
): void {
  const auth = connector.auth;
  if (auth.kind === 'none') return;

  const secret = (process.env[auth.envVar] ?? '').trim();
  if (secret.length === 0) {
    throw new ConnectorError(`${auth.envVar} is not set, so ${connector.name} cannot be used.`);
  }

  switch (auth.kind) {
    case 'bearer':
      headers.authorization = `${auth.prefix ?? 'Bearer'} ${secret}`;
      break;
    case 'header':
      headers[auth.header.toLowerCase()] = secret;
      break;
    case 'query':
      url.searchParams.set(auth.parameter, secret);
      break;
  }
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  status: number;
  text: string;
}

/**
 * Send the request with the socket pinned to a validated address.
 *
 * Same reasoning as the web guard: resolving DNS and then handing the hostname
 * to a client that resolves it again leaves a rebinding window.
 */
function send(
  url: URL,
  address: string,
  family: 4 | 6,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'https:') {
      reject(new ConnectorError(`Connectors must use https, not ${url.protocol}`));
      return;
    }

    let settled = false;

    const request = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: { ...init.headers, host: url.host },
        lookup: pinnedLookup(address, family),
        timeout: TIMEOUT_MS,
      },
      (response) => {
        settled = true;
        const chunks: Buffer[] = [];
        let total = 0;
        let capped = false;

        response.on('data', (chunk: Buffer) => {
          if (capped) return;
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            capped = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });

        const finish = () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        };

        response.on('end', finish);
        response.on('close', () => {
          if (capped) finish();
        });
        response.on('error', (error: Error) => {
          if (!capped) reject(new ConnectorError(`Read failed: ${error.message}`));
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new ConnectorError(`${url.host} timed out after ${TIMEOUT_MS / 1000}s.`));
    });

    request.on('error', (error: Error) => {
      if (settled) return;
      reject(
        error instanceof ConnectorError
          ? error
          : new ConnectorError(`Could not reach ${url.host}: ${error.message}`),
      );
    });

    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

function parseBody(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not every API returns JSON on every path; the text is still useful.
    return { raw: text.slice(0, 20_000) };
  }
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

function secretOf(connector: ConnectorDefinition): string | undefined {
  if (connector.auth.kind === 'none') return undefined;
  const value = (process.env[connector.auth.envVar] ?? '').trim();
  // Very short values would match everywhere and turn the output to noise.
  return value.length >= 8 ? value : undefined;
}

function redact(text: string, connector: ConnectorDefinition): string {
  const secret = secretOf(connector);
  return secret ? text.replaceAll(secret, '[redacted]') : text;
}

/**
 * Strip the credential out of a response, wherever it appears.
 *
 * Some APIs echo the authenticated request back, including its headers, and a
 * `query`-scheme connector puts the key in a URL that error messages then
 * quote. Neither should end up in the model's context or in the audit log.
 */
function redactDeep(value: unknown, connector: ConnectorDefinition): unknown {
  const secret = secretOf(connector);
  if (!secret) return value;

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 8) return node;
    if (typeof node === 'string') return node.replaceAll(secret, '[redacted]');
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child, depth + 1);
      }
      return out;
    }
    return node;
  };

  return walk(value, 0);
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
