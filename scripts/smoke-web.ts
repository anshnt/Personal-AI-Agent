/**
 * Web access checks, run against real local HTTP servers.
 *
 * The SSRF guard is the reason this file exists. Every assertion below is a
 * request that must be refused, or a redirect chain that must be re-validated
 * — and none of that can be shown with a mocked transport, because the whole
 * question is what the socket actually connects to.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/smoke-web.ts
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';

import { sql as client, db } from '@/lib/db';
import { users, webCache } from '@/lib/db/schema';
import { resolveCurrentUser } from '@/lib/db/users';
import { extractReadable } from '@/lib/web/extract';
import {
  FetchFailedError,
  UnsafeUrlError,
  isBlockedAddress,
  safeFetch,
  validateTarget,
} from '@/lib/web/guard';
import { cachedFetch, purgeExpired } from '@/lib/web/cache';
import { SearchError, type SearchProvider, type SearchResult } from '@/lib/web/providers';
import { runSearch } from '@/lib/web/search';

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`, detail === undefined ? '' : detail);
  }
}

async function expectRefusal(
  label: string,
  run: () => Promise<unknown>,
  expected: new (...args: never[]) => Error = UnsafeUrlError,
): Promise<void> {
  try {
    const value = await run();
    failures += 1;
    console.error(`  FAIL ${label} — expected a refusal, got`, value);
  } catch (error) {
    if (error instanceof expected) {
      console.log(`  ok   ${label} (${error.message.slice(0, 62)})`);
    } else {
      failures += 1;
      console.error(`  FAIL ${label} — wrong error type`, error);
    }
  }
}

/** Start a server on loopback and return its port. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function main(): Promise<void> {
  await db.delete(users);
  const user = await resolveCurrentUser();

  console.log('address classification');
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS, Azure and GCP instance metadata
    '100.100.100.200', // Alibaba metadata
    '100.64.0.1', // carrier-grade NAT
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '2001:db8::1',
    '64:ff9b::1',
    'not-an-ip',
    '',
  ];
  const wrongly = blocked.filter((address) => !isBlockedAddress(address));
  check('every private, reserved and malformed address is blocked', wrongly.length === 0, wrongly);

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  const wronglyBlocked = allowed.filter((address) => isBlockedAddress(address));
  check('ordinary public addresses are allowed', wronglyBlocked.length === 0, wronglyBlocked);

  // 172.15 and 172.32 sit just outside the private block: an off-by-one here
  // would either open a hole or break real sites.
  check('172.15.0.1 is public', !isBlockedAddress('172.15.0.1'));
  check('172.32.0.1 is public', !isBlockedAddress('172.32.0.1'));
  check('100.63.0.1 is public', !isBlockedAddress('100.63.0.1'));
  check('100.128.0.1 is public', !isBlockedAddress('100.128.0.1'));

  console.log('\nurl validation');
  await expectRefusal('file:// is refused', () => validateTarget('file:///etc/passwd'));
  await expectRefusal('gopher:// is refused', () => validateTarget('gopher://x.example/'));
  await expectRefusal('data: is refused', () => validateTarget('data:text/html,<b>x</b>'));
  await expectRefusal('ftp:// is refused', () => validateTarget('ftp://x.example/'));
  await expectRefusal('a bare string is refused', () => validateTarget('not a url'));
  await expectRefusal('localhost by name is refused', () => validateTarget('http://localhost/'));
  await expectRefusal('a .localhost name is refused', () => validateTarget('http://db.localhost/'));
  await expectRefusal('a .internal name is refused', () => validateTarget('http://metadata.internal/'));
  await expectRefusal('loopback by literal is refused', () => validateTarget('http://127.0.0.1:8080/'));
  await expectRefusal('metadata by literal is refused', () => validateTarget('http://169.254.169.254/latest/meta-data/'));
  await expectRefusal('a bracketed IPv6 loopback is refused', () => validateTarget('http://[::1]/'));
  await expectRefusal('embedded credentials are refused', () => validateTarget('http://user:pw@example.com/'));
  await expectRefusal(
    'a credential-prefixed lookalike host is refused',
    () => validateTarget('https://www.google.com@127.0.0.1/'),
  );
  await expectRefusal('a non-web port is refused', () => validateTarget('http://example.com:22/'));
  await expectRefusal('the postgres port is refused', () => validateTarget('http://example.com:5432/'));

  console.log('\nfetching a real server');
  const pageServer = createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<html><head><title>Tide tables</title><meta name="description" content="When the water moves">' +
          '<style>nav{display:none}</style><script>track()</script></head>' +
          '<body><nav>Home About</nav><article><h1>Tide tables</h1>' +
          '<p>High water at 06:12 and 18:34.</p><p>The harbour closes at low water.</p></article>' +
          '<footer>Copyright someone</footer></body></html>',
      );
      return;
    }
    if (request.url === '/huge') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      // Deliberately no content-length: the cap must work on arriving bytes.
      for (let i = 0; i < 400; i += 1) response.write('x'.repeat(4096));
      response.end();
      return;
    }
    if (request.url === '/binary') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (request.url === '/redirect-to-metadata') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
      return;
    }
    if (request.url === '/redirect-to-loopback') {
      response.writeHead(302, { location: 'http://127.0.0.1:8080/admin' });
      response.end();
      return;
    }
    if (request.url === '/redirect-loop') {
      response.writeHead(302, { location: '/redirect-loop' });
      response.end();
      return;
    }
    if (request.url === '/redirect-ok') {
      response.writeHead(302, { location: '/page' });
      response.end();
      return;
    }
    if (request.url === '/slow') {
      // Never responds, so the timeout has something to fire on.
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('nope');
  });

  const port = await listen(pageServer);
  const base = `http://127.0.0.1:${port}`;

  await expectRefusal(
    'a loopback URL is refused even though the server is up',
    () => safeFetch(`${base}/page`),
  );

  // Opting the local server in is the documented escape hatch for a
  // self-hosted endpoint, and it is what lets the transport be exercised
  // end to end without weakening the guard itself.
  process.env.WEB_FETCH_ALLOW_HOSTS = `127.0.0.1:${port}`;

  const page = await safeFetch(`${base}/page`);
  check('a page is fetched', page.status === 200, page.status);
  check('the content type is reported', page.contentType === 'text/html', page.contentType);
  check('the body arrives', page.body.includes('High water at 06:12'), page.body.slice(0, 80));

  const big = await safeFetch(`${base}/huge`, { maxBytes: 50_000 });
  check('an oversized body is capped', big.body.length <= 50_000, big.body.length);
  check('truncation is reported', big.truncated === true);

  await expectRefusal(
    'a binary response is refused',
    () => safeFetch(`${base}/binary`),
    FetchFailedError,
  );

  const allowed2 = await safeFetch(`${base}/binary`, { allowAnyContentType: true });
  check('binary can be opted into', allowed2.status === 200);

  const redirected = await safeFetch(`${base}/redirect-ok`);
  check('an in-scope redirect is followed', redirected.body.includes('High water'), redirected.finalUrl);
  check('the redirect chain is reported', redirected.redirects.length === 1, redirected.redirects);

  await expectRefusal(
    'a redirect to cloud metadata is refused',
    () => safeFetch(`${base}/redirect-to-metadata`),
  );
  await expectRefusal(
    'a redirect to loopback is refused',
    () => safeFetch(`${base}/redirect-to-loopback`),
  );
  await expectRefusal(
    'a redirect loop is stopped',
    () => safeFetch(`${base}/redirect-loop`),
    FetchFailedError,
  );
  await expectRefusal(
    'a hanging server hits the timeout',
    () => safeFetch(`${base}/slow`, { timeoutMs: 700 }),
    FetchFailedError,
  );

  console.log('\nreadable extraction');
  const extracted = extractReadable(
    '<html><head><title>Tide tables</title>' +
      '<meta name="description" content="When the water moves"></head>' +
      '<body><nav>Home About</nav><article><h1>Tide tables</h1>' +
      '<p>High water at 06:12 and 18:34.</p></article><footer>Copyright</footer></body></html>',
    'https://tides.example/today',
  );
  check('the title is extracted', extracted.title === 'Tide tables', extracted.title);
  check('the description is extracted', extracted.description === 'When the water moves', extracted.description);
  check('the main text survives', extracted.text.includes('High water at 06:12'), extracted.text);
  check('navigation chrome is dropped', !extracted.text.includes('Home About'), extracted.text);
  check('the footer is dropped', !extracted.text.includes('Copyright'), extracted.text);

  const noArticle = extractReadable('<body><p>Just a paragraph in a bare body.</p></body>', 'https://x.example/');
  check('a page with no article element still extracts', noArticle.text.includes('Just a paragraph'), noArticle.text);

  console.log('\ncache');
  await db.delete(webCache);
  let hits = 0;
  const producer = async () => {
    hits += 1;
    return { value: `result-${hits}` };
  };

  const firstCall = await cachedFetch({ userId: user.id, kind: 'fetch', key: 'https://x.example/a', ttlSeconds: 60 }, producer);
  check('a cache miss calls through', hits === 1 && firstCall.value === 'result-1', firstCall);
  const secondCall = await cachedFetch({ userId: user.id, kind: 'fetch', key: 'https://x.example/a', ttlSeconds: 60 }, producer);
  check('a cache hit does not call through', hits === 1 && secondCall.value === 'result-1', { hits, secondCall });

  const otherKey = await cachedFetch({ userId: user.id, kind: 'fetch', key: 'https://x.example/b', ttlSeconds: 60 }, producer);
  check('a different key misses', hits === 2 && otherKey.value === 'result-2', otherKey);

  const otherKind = await cachedFetch({ userId: user.id, kind: 'search', key: 'https://x.example/a', ttlSeconds: 60 }, producer);
  check('the same key under a different kind misses', hits === 3, { hits, otherKind });

  // Expiry: rewrite the row's expiry into the past rather than sleeping.
  await db.update(webCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(webCache.userId, user.id));
  const afterExpiry = await cachedFetch({ userId: user.id, kind: 'fetch', key: 'https://x.example/a', ttlSeconds: 60 }, producer);
  check('an expired entry is refetched', hits === 4 && afterExpiry.value === 'result-4', afterExpiry);

  await db.update(webCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(webCache.userId, user.id));
  const purged = await purgeExpired();
  check('expired rows can be purged', purged >= 1, purged);

  console.log('\nsearch orchestration');
  class FakeSearch implements SearchProvider {
    readonly name = 'fake';
    calls = 0;
    constructor(private readonly results: SearchResult[], private readonly fail = false) {}
    async search(): Promise<SearchResult[]> {
      this.calls += 1;
      if (this.fail) throw new SearchError('provider unavailable');
      return this.results;
    }
  }

  const good = new FakeSearch([
    { title: 'Tide tables for August', url: 'https://tides.example/august', snippet: 'High water times' },
    { title: 'Duplicate', url: 'https://tides.example/august', snippet: 'same url' },
    { title: 'Blocked', url: 'http://169.254.169.254/', snippet: 'metadata' },
    { title: 'Other', url: 'https://harbour.example/hours', snippet: 'Opening hours' },
  ]);

  const searched = await runSearch({ userId: user.id, query: 'tide tables', provider: good, limit: 10 });
  check('search returns results', searched.results.length > 0, searched.results.length);
  check('duplicate urls are collapsed', searched.results.filter((r) => r.url === 'https://tides.example/august').length === 1, searched.results.map((r) => r.url));
  check('unsafe result urls are dropped', !searched.results.some((r) => r.url.includes('169.254')), searched.results.map((r) => r.url));
  check('the provider is named in the result', searched.provider === 'fake', searched.provider);

  const cachedSearch = await runSearch({ userId: user.id, query: 'tide tables', provider: good, limit: 10 });
  check('an identical search is served from cache', good.calls === 1, { calls: good.calls, cachedSearch: cachedSearch.cached });
  check('a cached search says so', cachedSearch.cached === true);

  const failing = new FakeSearch([], true);
  await expectRefusal(
    'a provider failure is reported, not swallowed',
    () => runSearch({ userId: user.id, query: 'anything at all', provider: failing }),
    SearchError,
  );

  console.log('\ncleanup');
  pageServer.close();
  delete process.env.WEB_FETCH_ALLOW_HOSTS;

  await db.delete(users).where(eq(users.id, user.id));
  check('deleting a user cascades their web cache', (await db.select().from(webCache)).length === 0);

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nsmoke run crashed', error);
  await client.end();
  process.exit(1);
});
