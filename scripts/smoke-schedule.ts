/**
 * Scheduling checks against a real database.
 *
 * The two things worth proving here need real Postgres: that two concurrent
 * runners cannot fire the same schedule (which is `FOR UPDATE SKIP LOCKED`
 * doing its job), and that an outage does not cause a backlog of missed
 * firings to replay.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/smoke-schedule.ts
 */

import { eq } from 'drizzle-orm';

import { sql as client, db } from '@/lib/db';
import { scheduleRuns, schedules, users } from '@/lib/db/schema';
import { resolveCurrentUser } from '@/lib/db/users';
import {
  InvalidScheduleError,
  checkCron,
  describeCron,
  nextOccurrence,
  skipMissed,
} from '@/lib/schedule/cron';
import {
  acknowledgeRuns,
  claimDueSchedules,
  createSchedule,
  deleteSchedule,
  finishRun,
  getSchedule,
  listSchedules,
  recentRuns,
  recordOutcome,
  startRun,
  unreadRuns,
  updateSchedule,
} from '@/lib/schedule/store';

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`, detail === undefined ? '' : detail);
  }
}

async function expectRejection(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    failures += 1;
    console.error(`  FAIL ${label} — expected a rejection, got`, value);
  } catch (error) {
    const ok = error instanceof InvalidScheduleError;
    if (ok) console.log(`  ok   ${label} (${error.message.slice(0, 60)})`);
    else {
      failures += 1;
      console.error(`  FAIL ${label} — wrong error type`, error);
    }
  }
}

const iso = (date: Date) => date.toISOString();

async function main(): Promise<void> {
  await db.delete(users);
  const user = await resolveCurrentUser();

  console.log('cron evaluation');
  const weekdays = checkCron('0 9 * * 1-5', 'Asia/Kolkata', new Date('2026-08-27T00:00:00Z'));
  check(
    'weekday 09:00 IST resolves to 03:30 UTC',
    iso(weekdays.upcoming[0]!) === '2026-08-27T03:30:00.000Z',
    weekdays.upcoming.map(iso),
  );
  check(
    'the weekend is skipped',
    iso(weekdays.upcoming[2]!) === '2026-08-31T03:30:00.000Z',
    weekdays.upcoming.map(iso),
  );

  // DST is the case a naive fixed-offset implementation gets wrong.
  const berlinWinter = nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-01-10T00:00:00Z'));
  const berlinSummer = nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-07-10T00:00:00Z'));
  check('09:00 Berlin in winter is 08:00 UTC', iso(berlinWinter) === '2026-01-10T08:00:00.000Z', iso(berlinWinter));
  check('09:00 Berlin in summer is 07:00 UTC', iso(berlinSummer) === '2026-07-10T07:00:00.000Z', iso(berlinSummer));

  const acrossFallBack = nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-10-24T08:00:00Z'));
  check(
    'the offset flips on the transition day itself',
    iso(acrossFallBack) === '2026-10-25T08:00:00.000Z',
    iso(acrossFallBack),
  );

  await expectRejection('a malformed cron is rejected', async () => checkCron('nonsense', 'UTC'));
  await expectRejection('the wrong field count is rejected', async () => checkCron('0 9 * *', 'UTC'));
  await expectRejection('an invalid timezone is rejected', async () => checkCron('0 9 * * *', 'Not/AZone'));
  // A per-minute schedule is a runaway, and each agent_run firing costs tokens.
  await expectRejection('a per-minute cron is rejected', async () => checkCron('* * * * *', 'UTC'));
  await expectRejection('an every-two-minute cron is rejected', async () => checkCron('*/2 * * * *', 'UTC'));
  check('an every-fifteen-minute cron is allowed', checkCron('*/15 * * * *', 'UTC').upcoming.length === 5);

  check(
    'a daily cron is described in plain language',
    describeCron('0 9 * * *', 'Europe/Berlin') === 'every day at 09:00 Europe/Berlin',
    describeCron('0 9 * * *', 'Europe/Berlin'),
  );
  check(
    'a weekday cron is described in plain language',
    describeCron('30 7 * * 1-5', 'UTC') === 'every weekday at 07:30 UTC',
    describeCron('30 7 * * 1-5', 'UTC'),
  );

  console.log('\nmissed firings');
  // Three days of a daily schedule missed while nothing was running.
  const outageStart = new Date('2026-08-20T09:00:00Z');
  const now = new Date('2026-08-23T12:00:00Z');
  const caught = skipMissed('0 9 * * *', 'UTC', outageStart, now);
  check('missed firings are skipped, not replayed', caught.skipped >= 2, caught);
  check('the next firing is in the future', caught.next > now, iso(caught.next));
  check('the next firing keeps the original cadence', iso(caught.next) === '2026-08-24T09:00:00.000Z', iso(caught.next));

  const noOutage = skipMissed('0 9 * * *', 'UTC', new Date('2026-08-23T09:00:00Z'), new Date('2026-08-23T09:00:30Z'));
  check('a firing that just happened is not double-skipped', noOutage.skipped === 0, noOutage);

  console.log('\ncreating schedules');
  const oneShot = await createSchedule({
    userId: user.id,
    title: 'Call the dentist',
    kind: 'reminder',
    payload: 'Ring the dentist about the appointment',
    runAt: new Date(Date.now() + 60_000),
    timezone: 'Asia/Kolkata',
  });
  check('a one-off is stored', oneShot.cron === null && oneShot.runAt !== null, oneShot);
  check('the one-off is due at its run time', oneShot.nextRunAt?.getTime() === oneShot.runAt?.getTime());

  const recurring = await createSchedule({
    userId: user.id,
    title: 'Morning briefing',
    kind: 'agent_run',
    payload: 'Summarise anything urgent in my mail and list what is due today.',
    cron: '0 7 * * *',
    timezone: 'Asia/Kolkata',
  });
  check('a recurring schedule is stored', recurring.cron === '0 7 * * *', recurring.cron);
  check('the recurring schedule has a future due time', (recurring.nextRunAt?.getTime() ?? 0) > Date.now());

  await expectRejection('neither cron nor run_at is rejected', () =>
    createSchedule({ userId: user.id, title: 'x', kind: 'reminder', payload: 'y', timezone: 'UTC' }),
  );
  await expectRejection('both cron and run_at is rejected', () =>
    createSchedule({
      userId: user.id,
      title: 'x',
      kind: 'reminder',
      payload: 'y',
      cron: '0 9 * * *',
      runAt: new Date(Date.now() + 60_000),
      timezone: 'UTC',
    }),
  );
  await expectRejection('a run_at in the past is rejected', () =>
    createSchedule({
      userId: user.id,
      title: 'x',
      kind: 'reminder',
      payload: 'y',
      runAt: new Date(Date.now() - 60_000),
      timezone: 'UTC',
    }),
  );
  await expectRejection('an empty payload is rejected', () =>
    createSchedule({
      userId: user.id,
      title: 'x',
      kind: 'reminder',
      payload: '   ',
      runAt: new Date(Date.now() + 60_000),
      timezone: 'UTC',
    }),
  );

  console.log('\nclaiming due work');
  // Make both due.
  await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.userId, user.id));

  const firstClaim = await claimDueSchedules(10);
  check('due schedules are claimed', firstClaim.length === 2, firstClaim.length);

  const secondClaim = await claimDueSchedules(10);
  check('a second claim finds nothing, because the first advanced them', secondClaim.length === 0, secondClaim.length);

  const afterClaim = await getSchedule(user.id, oneShot.id);
  check('a one-off completes after firing', afterClaim?.status === 'completed', afterClaim?.status);
  check('a completed one-off has no next run', afterClaim?.nextRunAt === null, afterClaim?.nextRunAt);
  check('lastRunAt is set', afterClaim?.lastRunAt !== null);

  const recurringAfter = await getSchedule(user.id, recurring.id);
  check('a recurring schedule stays active', recurringAfter?.status === 'active', recurringAfter?.status);
  check(
    'a recurring schedule is rescheduled into the future',
    (recurringAfter?.nextRunAt?.getTime() ?? 0) > Date.now(),
    recurringAfter?.nextRunAt,
  );

  // Concurrency: two claims racing must not both get the same row.
  await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000), status: 'active' }).where(eq(schedules.id, recurring.id));
  const [raceA, raceB] = await Promise.all([claimDueSchedules(10), claimDueSchedules(10)]);
  const claimedIds = [...raceA, ...raceB].map((s) => s.id);
  check(
    'two concurrent claims never return the same schedule',
    claimedIds.length === new Set(claimedIds).size && claimedIds.length === 1,
    { a: raceA.map((s) => s.id), b: raceB.map((s) => s.id) },
  );

  console.log('\nrun records');
  const scheduleForRuns = await getSchedule(user.id, recurring.id);
  if (!scheduleForRuns) throw new Error('expected the recurring schedule to exist');

  const run = await startRun(scheduleForRuns, new Date());
  check('a run starts in the running state', run.status === 'running', run.status);

  await finishRun(run.id, { status: 'succeeded', output: 'Two urgent emails, three tasks due.' });
  await recordOutcome(scheduleForRuns.id, { ok: true });

  const runs = await recentRuns(user.id, { scheduleId: recurring.id });
  check('the run is recorded', runs.length === 1 && runs[0]?.status === 'succeeded', runs.map((r) => r.status));
  check('the output is stored', runs[0]?.output?.includes('urgent emails') === true, runs[0]?.output);

  const counted = await getSchedule(user.id, recurring.id);
  check('a success increments the run count', (counted?.runCount ?? 0) >= 1, counted?.runCount);
  check('a success clears the error state', counted?.lastError === null && counted?.consecutiveFailures === 0);

  const unread = await unreadRuns(user.id);
  check('an unacknowledged run is unread', unread.length === 1, unread.length);
  check('the unread run carries the schedule title', unread[0]?.title === 'Morning briefing', unread[0]?.title);

  const marked = await acknowledgeRuns(user.id, [run.id]);
  check('a run can be acknowledged', marked === 1, marked);
  check('an acknowledged run is no longer unread', (await unreadRuns(user.id)).length === 0);

  console.log('\nrepeated failures');
  const flaky = await createSchedule({
    userId: user.id,
    title: 'Broken job',
    kind: 'agent_run',
    payload: 'This one always fails for the purposes of this check.',
    cron: '0 3 * * *',
    timezone: 'UTC',
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await recordOutcome(flaky.id, { ok: false, error: 'the tool it needs is not configured' });
  }
  const brokenAfter = await getSchedule(user.id, flaky.id);
  check('a repeatedly failing schedule stops itself', brokenAfter?.status === 'failed', brokenAfter?.status);
  check('the failure reason is kept', brokenAfter?.lastError?.includes('not configured') === true, brokenAfter?.lastError);
  check('a failed schedule is not claimed', (await claimDueSchedules(10)).every((s) => s.id !== flaky.id));

  // Resuming clears the failure state and recomputes the timing.
  const resumed = await updateSchedule(user.id, flaky.id, { status: 'active' });
  check('resuming clears the error', resumed?.lastError === null && resumed?.consecutiveFailures === 0, resumed);
  check('resuming recomputes a future due time', (resumed?.nextRunAt?.getTime() ?? 0) > Date.now(), resumed?.nextRunAt);

  console.log('\npausing and updating');
  const paused = await updateSchedule(user.id, recurring.id, { status: 'paused' });
  check('a schedule can be paused', paused?.status === 'paused', paused?.status);
  check('a paused schedule is not listed as active', (await listSchedules(user.id)).every((s) => s.id !== recurring.id));
  check('a paused schedule is still listed with include_inactive', (await listSchedules(user.id, { includeInactive: true })).some((s) => s.id === recurring.id));

  // A schedule paused for a long time must not fire immediately on resume.
  await db.update(schedules).set({ nextRunAt: new Date('2026-01-01T00:00:00Z') }).where(eq(schedules.id, recurring.id));
  const resumedLate = await updateSchedule(user.id, recurring.id, { status: 'active' });
  check(
    'resuming a long-paused schedule does not leave it overdue',
    (resumedLate?.nextRunAt?.getTime() ?? 0) > Date.now(),
    resumedLate?.nextRunAt,
  );

  const retimed = await updateSchedule(user.id, recurring.id, { cron: '30 18 * * 5' });
  check('the cron can be changed', retimed?.cron === '30 18 * * 5', retimed?.cron);
  check('changing the cron recomputes the due time', (retimed?.nextRunAt?.getTime() ?? 0) > Date.now());

  await expectRejection('an invalid cron on update is rejected', () =>
    updateSchedule(user.id, recurring.id, { cron: 'not a cron' }),
  );
  const stillValid = await getSchedule(user.id, recurring.id);
  check('a rejected update leaves the schedule untouched', stillValid?.cron === '30 18 * * 5', stillValid?.cron);

  console.log('\nmax runs');
  const twice = await createSchedule({
    userId: user.id,
    title: 'Twice only',
    kind: 'reminder',
    payload: 'Second of two',
    cron: '0 12 * * *',
    timezone: 'UTC',
    maxRuns: 2,
  });

  await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.id, twice.id));
  await claimDueSchedules(10);
  await recordOutcome(twice.id, { ok: true });
  const afterFirst = await getSchedule(user.id, twice.id);
  check('a capped schedule stays active before its cap', afterFirst?.status === 'active', afterFirst?.status);

  await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.id, twice.id));
  await claimDueSchedules(10);
  const afterSecond = await getSchedule(user.id, twice.id);
  check('a capped schedule completes at its cap', afterSecond?.status === 'completed', afterSecond?.status);
  check('a completed schedule has no next run', afterSecond?.nextRunAt === null);

  console.log('\ntenant isolation');
  const [other] = await db.insert(users).values({ email: 'other@example.com' }).returning();
  if (!other) throw new Error('expected a second user');
  check("another user cannot read the schedule", (await getSchedule(other.id, recurring.id)) === undefined);
  check("another user cannot update it", (await updateSchedule(other.id, recurring.id, { title: 'Hijacked' })) === undefined);
  check("another user cannot delete it", (await deleteSchedule(other.id, recurring.id)) === false);
  check("another user sees no runs", (await recentRuns(other.id)).length === 0);
  check('the owner can delete it', (await deleteSchedule(user.id, recurring.id)) === true);

  console.log('\ncascade');
  await db.delete(users).where(eq(users.id, user.id));
  check('deleting a user cascades their schedules', (await db.select().from(schedules)).length === 0);
  check('deleting a user cascades their runs', (await db.select().from(scheduleRuns)).length === 0);

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nsmoke run crashed', error);
  await client.end();
  process.exit(1);
});
