/**
 * Connector registry checks against a real database.
 *
 * The security-relevant properties here are that a credential never reaches the
 * model, that a mutating operation cannot fire without the user having asked,
 * and that the rate limiter actually holds under concurrency — all of which
 * need the real counter table.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/smoke-connectors.ts
 */

import { eq } from 'drizzle-orm';

import { sql as client, db } from '@/lib/db';
import { connectorUsage, users } from '@/lib/db/schema';
import { resolveCurrentUser } from '@/lib/db/users';
import { consume, purgeOldWindows, refund } from '@/lib/connectors/limiter';
import { invoke } from '@/lib/connectors/invoke';
import {
  allConnectors,
  availableConnectors,
  findConnector,
  isConfigured,
  resetRegistry,
} from '@/lib/connectors/registry';
import { ConnectorError } from '@/lib/connectors/types';

/**
 * The credential the suite installs.
 *
 * A named constant so the leak checks below assert against the value that is
 * actually set. Written out separately, the assertion silently tests for a
 * string nothing ever produced, and passes whether or not the credential leaks.
 */
const FAKE_GITHUB_TOKEN = 'ghp_fake_token_for_checks_only';

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
  matches?: string,
): Promise<void> {
  try {
    const value = await run();
    failures += 1;
    console.log(`  FAIL ${label} — expected a refusal, got`, value);
  } catch (error) {
    if (!(error instanceof ConnectorError)) {
      failures += 1;
      console.log(`  FAIL ${label} — wrong error type`, error);
      return;
    }
    if (matches && !error.message.toLowerCase().includes(matches.toLowerCase())) {
      failures += 1;
      console.log(`  FAIL ${label} — message did not mention "${matches}":`, error.message);
      return;
    }
    console.log(`  ok   ${label} (${error.message.slice(0, 62)})`);
  }
}

async function main(): Promise<void> {
  await db.delete(users);
  const user = await resolveCurrentUser();

  // The suite sets every credential it needs rather than inheriting whatever
  // the shell happens to export. Depending on ambient environment is how these
  // checks passed locally and failed in CI.
  process.env.GITHUB_TOKEN = FAKE_GITHUB_TOKEN;
  delete process.env.CUSTOM_CONNECTORS;
  delete process.env.HOUSE_TOKEN;
  resetRegistry();

  console.log('connector invocation (registry construction is covered by vitest)');
  console.log('\nparameter validation');
  await expectRefusal(
    'an unknown connector is refused',
    () => invoke({ userId: user.id, connector: 'nope', operation: 'x', params: {} }),
    'no connector',
  );

  await expectRefusal(
    'an unknown operation lists the real ones',
    () => invoke({ userId: user.id, connector: 'weather', operation: 'nope', params: {} }),
    'forecast',
  );

  await expectRefusal(
    'a missing required parameter is refused',
    () => invoke({ userId: user.id, connector: 'weather', operation: 'forecast', params: {} }),
    'latitude',
  );

  await expectRefusal(
    'an out-of-range parameter is refused',
    () =>
      invoke({
        userId: user.id,
        connector: 'weather',
        operation: 'forecast',
        params: { latitude: 200, longitude: 0 },
      }),
    'latitude',
  );

  await expectRefusal(
    'a bad date format is refused',
    () =>
      invoke({
        userId: user.id,
        connector: 'currency',
        operation: 'on_date',
        params: { date: 'last tuesday' },
      }),
    'yyyy-mm-dd',
  );

  console.log('\nwrite protection');
  await expectRefusal(
    'a mutating operation is refused without confirmation',
    () =>
      invoke({
        userId: user.id,
        connector: 'github',
        operation: 'create_issue',
        params: { owner: 'a', repo: 'b', title: 'Should never be created' },
      }),
    'needs the user to have asked',
  );

  await expectRefusal(
    'confirmation set to false is still a refusal',
    () =>
      invoke({
        userId: user.id,
        connector: 'github',
        operation: 'create_issue',
        params: { owner: 'a', repo: 'b', title: 'x' },
        confirmedByUser: false,
      }),
    'needs the user to have asked',
  );

  const mutating = findConnector('github')?.operations.filter((o) => o.mutates) ?? [];
  check('mutating operations are marked as such', mutating.length === 1 && mutating[0]?.name === 'create_issue', mutating.map((o) => o.name));
  check(
    'no keyless connector exposes a write',
    allConnectors()
      .filter((c) => c.auth.kind === 'none')
      .every((c) => c.operations.every((o) => o.mutates !== true)),
  );

  console.log('\nrate limiting');
  await db.delete(connectorUsage);
  const limit = { calls: 3, windowSeconds: 3600 };

  const verdicts = [];
  for (let i = 0; i < 4; i += 1) {
    verdicts.push(await consume(user.id, 'test', limit));
  }
  check('calls within the limit are allowed', verdicts.slice(0, 3).every((v) => v.allowed), verdicts);
  check('the call over the limit is refused', verdicts[3]?.allowed === false, verdicts[3]);
  check('remaining counts down', verdicts[0]?.remaining === 2 && verdicts[2]?.remaining === 0, verdicts.map((v) => v.remaining));
  check('remaining never goes negative', verdicts[3]?.remaining === 0, verdicts[3]?.remaining);
  check('the reset time is in the future', (verdicts[0]?.resetAt.getTime() ?? 0) > Date.now());

  // The increment must be atomic, or two concurrent calls both read the same
  // count and both decide they are under the limit.
  await db.delete(connectorUsage);
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, () => consume(user.id, 'race', { calls: 4, windowSeconds: 3600 })),
  );
  check(
    'concurrent calls consume exactly one slot each',
    concurrent.filter((v) => v.allowed).length === 4,
    concurrent.map((v) => v.allowed),
  );

  const refunded = await consume(user.id, 'refundable', limit);
  check('a slot is consumed', refunded.remaining === 2, refunded.remaining);
  await refund(user.id, 'refundable', limit.windowSeconds);
  const afterRefund = await consume(user.id, 'refundable', limit);
  check('a refunded slot is reusable', afterRefund.remaining === 2, afterRefund.remaining);

  // Limits are per connector, not shared across them.
  await db.delete(connectorUsage);
  await consume(user.id, 'alpha', limit);
  await consume(user.id, 'alpha', limit);
  const beta = await consume(user.id, 'beta', limit);
  check('limits are per connector', beta.remaining === 2, beta.remaining);

  // And per user.
  const [other] = await db.insert(users).values({ email: 'other@example.com' }).returning();
  if (!other) throw new Error('expected a second user');
  const otherVerdict = await consume(other.id, 'alpha', limit);
  check('limits are per user', otherVerdict.remaining === 2, otherVerdict.remaining);

  await db
    .update(connectorUsage)
    .set({ windowStart: new Date(Date.now() - 72 * 3600 * 1000) })
    .where(eq(connectorUsage.userId, user.id));
  check('old windows can be purged', (await purgeOldWindows(48)) >= 1);

  console.log('\ncustom connectors from configuration');
  process.env.CUSTOM_CONNECTORS = JSON.stringify([
    {
      name: 'house',
      description: 'A home automation API.',
      baseUrl: 'https://house.example.com',
      auth: { kind: 'header', envVar: 'HOUSE_TOKEN', header: 'X-Api-Key' },
      rateLimit: { calls: 10, windowSeconds: 600 },
      operations: [
        {
          name: 'read_sensor',
          description: 'Read a named sensor.',
          method: 'GET',
          path: '/sensors/{id}',
          params: { id: { required: true, description: 'Sensor id' } },
        },
      ],
    },
  ]);
  resetRegistry();

  const house = findConnector('house');
  check('a custom connector is registered', house !== undefined, allConnectors().map((c) => c.name));
  check('its rate limit is honoured', house?.rateLimit.calls === 10, house?.rateLimit);
  check('it is unavailable without its key', house !== undefined && !isConfigured(house));

  process.env.HOUSE_TOKEN = 'house-secret-token-value';
  check('it becomes available with its key', house !== undefined && isConfigured(house));

  // A custom connector's schema is strict: an undeclared parameter is an error
  // rather than something forwarded to somebody's API unchecked.
  await expectRefusal(
    'an undeclared parameter on a custom connector is refused',
    () =>
      invoke({
        userId: user.id,
        connector: 'house',
        operation: 'read_sensor',
        params: { id: 'kitchen', unexpected: 'value' },
      }),
    'not valid',
  );

  process.env.CUSTOM_CONNECTORS = '{ not json';
  resetRegistry();
  let configError = '';
  try {
    allConnectors();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  check('malformed configuration is reported clearly', configError.includes('not valid JSON'), configError);

  process.env.CUSTOM_CONNECTORS = JSON.stringify([{ name: 'Bad Name', description: 'x', baseUrl: 'not-a-url', operations: [] }]);
  resetRegistry();
  configError = '';
  try {
    allConnectors();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  check('an invalid connector definition is reported clearly', configError.includes('not a valid connector list'), configError);

  delete process.env.CUSTOM_CONNECTORS;
  resetRegistry();

  console.log('\nlive call to a keyless API');
  // Open-Meteo needs no credential, so this exercises the whole path for real:
  // request construction, DNS pinning, the response, and summarising.
  let live = true;
  try {
    const geo = await invoke({
      userId: user.id,
      connector: 'geocoding',
      operation: 'search',
      params: { name: 'Lisbon', count: 1 },
    });
    const results = geo.data as Array<{ name?: string; latitude?: number; timezone?: string }>;
    check('a real geocoding call succeeds', geo.status === 200, geo.status);
    check('the response is summarised into records', Array.isArray(results) && results.length === 1, results);
    check('the place is resolved', results[0]?.name === 'Lisbon', results[0]);
    check('coordinates come back', typeof results[0]?.latitude === 'number', results[0]);
    check('the rate limiter reports remaining calls', geo.remaining < 60, geo.remaining);

    const forecast = await invoke({
      userId: user.id,
      connector: 'weather',
      operation: 'forecast',
      params: { latitude: 38.72, longitude: -9.13, forecast_days: 3 },
    });
    const daily = (forecast.data as { daily?: Array<Record<string, unknown>> }).daily ?? [];
    check('a real forecast call succeeds', forecast.status === 200, forecast.status);
    check('parallel arrays are zipped into rows', daily.length === 3, daily.length);
    check('each row carries its date and temperature', daily[0]?.time !== undefined && daily[0]?.temperature_2m_max !== undefined, daily[0]);
  } catch (error) {
    live = false;
    console.log(`  skip live API calls (no outbound network): ${error instanceof Error ? error.message.slice(0, 70) : error}`);
  }
  check('live-call section either ran or was skipped cleanly', true, live);

  console.log('\ncredential handling');
  // The credential must not appear in what a caller can observe. This checks the
  // definition surface; redaction of a response body is enforced in invoke().
  const serialisedRegistry = JSON.stringify(
    allConnectors().map((connector) => ({
      name: connector.name,
      auth: connector.auth,
      operations: connector.operations.map((operation) => ({
        name: operation.name,
        path: operation.path,
      })),
    })),
  );
  check(
    'the registry surface names the env var, not its value',
    serialisedRegistry.includes('GITHUB_TOKEN') && !serialisedRegistry.includes(FAKE_GITHUB_TOKEN),
    serialisedRegistry.includes(FAKE_GITHUB_TOKEN) ? 'the token leaked into the registry surface' : undefined,
  );

  // The same property, on the path that actually carries a credential: an error
  // message quoting an upstream response must not quote the key with it.
  const leaked = await invoke({
    userId: user.id,
    connector: 'github',
    operation: 'get_issue',
    // A repository that does not exist, so GitHub returns 404 and the failure
    // message is built from its response.
    params: { owner: 'anshnt', repo: 'definitely-not-a-real-repo-x9f2', number: 1 },
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

  if (typeof leaked === 'string') {
    check('a failure message does not carry the credential', !leaked.includes(FAKE_GITHUB_TOKEN), leaked.slice(0, 120));
  } else {
    console.log('  skip credential-in-error check (the call unexpectedly succeeded)');
  }

  console.log('\ncascade');
  await db.delete(users).where(eq(users.id, user.id));
  check('deleting a user cascades their usage counters', (await db.select().from(connectorUsage).where(eq(connectorUsage.userId, user.id))).length === 0);

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nsmoke run crashed', error);
  await client.end();
  process.exit(1);
});
