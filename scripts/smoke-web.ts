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
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  // One stream throughout: stdout and stderr interleave unpredictably in a CI
  // log, which puts a failure under the wrong section heading.
  console.log(`  FAIL ${label}`, detail === undefined ? '' : detail);
}

async function expectRefusal(
  label: string,
  run: () => Promise<unknown>,
  expected: new (...args: never[]) => Error = UnsafeUrlError,
): Promise<void> {
  try {
    const value = await run();
    failures += 1;
    console.log(`  FAIL ${label} — expected a refusal, got`, value);
  } catch (error) {
    if (error instanceof expected) {
      console.log(`  ok   ${label} (${error.message.slice(0, 62)})`);
    } else {
      failures += 1;
      console.log(`  FAIL ${label} — wrong error type`, error);
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

  console.log('outbound fetch (address and url rules are covered by vitest)');
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

  // The checks above reach the server by IP literal, where Node skips DNS
  // entirely — so they never exercise the pinning path. This one goes through a
  // hostname, which is how a real fetch works, and is what caught the custom
  // `lookup` answering in the wrong shape.
  const HOSTNAME = 'agent-smoke.test';
  let hostnameResolves = true;
  try {
    const { lookup } = await import('node:dns/promises');
    await lookup(HOSTNAME);
  } catch {
    hostnameResolves = false;
  }

  if (hostnameResolves) {
    process.env.WEB_FETCH_ALLOW_HOSTS = `${HOSTNAME}:${port},127.0.0.1:${port}`;
    const viaHostname = await safeFetch(`http://${HOSTNAME}:${port}/page`);
    check('a fetch by hostname resolves, pins, and connects', viaHostname.status === 200, viaHostname.status);
    check('the pinned fetch returns the real body', viaHostname.body.includes('High water at 06:12'), viaHostname.body.slice(0, 60));

    const target = await validateTarget(`http://${HOSTNAME}:${port}/page`);
    check('validation reports the resolved address', target.address === '127.0.0.1', target.address);

    const redirectByHostname = await safeFetch(`http://${HOSTNAME}:${port}/redirect-ok`);
    check('a redirect is re-resolved and re-pinned per hop', redirectByHostname.body.includes('High water'), redirectByHostname.finalUrl);
  } else {
    console.log(`  skip hostname pinning checks (${HOSTNAME} does not resolve here)`);
  }

  // Readable extraction are pure and are covered by the vitest suite; what needs the
  // database is below.

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
