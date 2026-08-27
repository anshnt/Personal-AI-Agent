import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  scheduleRuns,
  schedules,
  type Schedule,
  type ScheduleKind,
  type ScheduleRun,
} from '@/lib/db/schema';
import { isValidTimezone } from '@/lib/time';
import { InvalidScheduleError, checkCron, nextOccurrence, skipMissed } from './cron';

export interface CreateScheduleInput {
  userId: string;
  title: string;
  kind: ScheduleKind;
  payload: string;
  /** Exactly one of cron or runAt. */
  cron?: string;
  runAt?: Date;
  timezone: string;
  maxRuns?: number;
  sourceConversationId?: string | null;
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  const title = input.title.trim();
  if (title.length === 0) throw new InvalidScheduleError('A schedule needs a title');

  const payload = input.payload.trim();
  if (payload.length === 0) {
    throw new InvalidScheduleError(
      input.kind === 'reminder'
        ? 'A reminder needs the text to show.'
        : 'An agent run needs the prompt to run.',
    );
  }

  if (!isValidTimezone(input.timezone)) {
    throw new InvalidScheduleError(`"${input.timezone}" is not a valid IANA timezone.`);
  }

  const hasCron = input.cron !== undefined && input.cron.trim().length > 0;
  const hasRunAt = input.runAt !== undefined;

  if (hasCron === hasRunAt) {
    throw new InvalidScheduleError(
      'Give either a cron expression for a repeating schedule or run_at for a one-off, not both and not neither.',
    );
  }

  let nextRunAt: Date;
  if (hasCron && input.cron) {
    // Validated before storing: a schedule that cannot be evaluated is worse
    // than a rejected one, because it looks set up and silently never fires.
    checkCron(input.cron, input.timezone);
    nextRunAt = nextOccurrence(input.cron, input.timezone);
  } else if (input.runAt) {
    if (input.runAt.getTime() <= Date.now()) {
      throw new InvalidScheduleError('That time is in the past.');
    }
    nextRunAt = input.runAt;
  } else {
    throw new InvalidScheduleError('No timing given.');
  }

  const [created] = await db
    .insert(schedules)
    .values({
      userId: input.userId,
      title,
      kind: input.kind,
      payload,
      cron: hasCron ? (input.cron?.trim() ?? null) : null,
      runAt: input.runAt ?? null,
      timezone: input.timezone,
      nextRunAt,
      maxRuns: input.maxRuns ?? null,
      sourceConversationId: input.sourceConversationId ?? null,
    })
    .returning();

  if (!created) throw new InvalidScheduleError('Failed to store the schedule');
  return created;
}

export async function listSchedules(
  userId: string,
  options: { includeInactive?: boolean } = {},
): Promise<Schedule[]> {
  const filters = [eq(schedules.userId, userId)];
  if (!options.includeInactive) filters.push(eq(schedules.status, 'active'));

  return db
    .select()
    .from(schedules)
    .where(and(...filters))
    .orderBy(sql`${schedules.nextRunAt} asc nulls last`)
    .limit(200);
}

export async function getSchedule(
  userId: string,
  scheduleId: string,
): Promise<Schedule | undefined> {
  const rows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
    .limit(1);
  return rows[0];
}

export interface UpdateScheduleInput {
  title?: string;
  payload?: string;
  cron?: string | null;
  runAt?: Date | null;
  timezone?: string;
  status?: 'active' | 'paused';
  maxRuns?: number | null;
}

/**
 * Change a schedule.
 *
 * Any change to the timing recomputes `nextRunAt`, and so does resuming a
 * paused schedule: a schedule paused for a week must not fire immediately on
 * resume because its stored due time is long past.
 */
export async function updateSchedule(
  userId: string,
  scheduleId: string,
  patch: UpdateScheduleInput,
): Promise<Schedule | undefined> {
  const existing = await getSchedule(userId, scheduleId);
  if (!existing) return undefined;

  const timezone = patch.timezone ?? existing.timezone;
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
    throw new InvalidScheduleError(`"${patch.timezone}" is not a valid IANA timezone.`);
  }

  const changes: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title.length === 0) throw new InvalidScheduleError('A schedule needs a title');
    changes.title = title;
  }
  if (patch.payload !== undefined) {
    const payload = patch.payload.trim();
    if (payload.length === 0) throw new InvalidScheduleError('A schedule needs a payload');
    changes.payload = payload;
  }
  if (patch.timezone !== undefined) changes.timezone = patch.timezone;
  if (patch.maxRuns !== undefined) changes.maxRuns = patch.maxRuns;

  const cron = patch.cron !== undefined ? patch.cron : existing.cron;
  const runAt = patch.runAt !== undefined ? patch.runAt : existing.runAt;
  const timingChanged =
    patch.cron !== undefined || patch.runAt !== undefined || patch.timezone !== undefined;
  const resuming = patch.status === 'active' && existing.status !== 'active';

  if (timingChanged || resuming) {
    if (cron && cron.trim().length > 0) {
      checkCron(cron, timezone);
      changes.cron = cron.trim();
      changes.runAt = null;
      changes.nextRunAt = nextOccurrence(cron, timezone);
    } else if (runAt) {
      if (runAt.getTime() <= Date.now()) {
        throw new InvalidScheduleError('That time is in the past.');
      }
      changes.cron = null;
      changes.runAt = runAt;
      changes.nextRunAt = runAt;
    } else {
      throw new InvalidScheduleError('A schedule needs either a cron expression or a run_at time.');
    }
  }

  if (patch.status !== undefined) {
    changes.status = patch.status;
    // Resuming clears the failure state; a paused schedule's old error is not
    // information about the schedule going forward.
    if (patch.status === 'active') {
      changes.lastError = null;
      changes.consecutiveFailures = 0;
    }
  }

  const [updated] = await db
    .update(schedules)
    .set(changes)
    .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
    .returning();

  return updated;
}

export async function deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
  const deleted = await db
    .delete(schedules)
    .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
    .returning({ id: schedules.id });
  return deleted.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Claiming due work                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Atomically claim the schedules that are due.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole point. Two overlapping cron pings — a
 * slow run still in flight when the next one arrives, or two instances behind a
 * load balancer — must not both fire the same schedule, and the user would
 * experience that as duplicate reminders and double-billed agent runs. Rows
 * claimed by one transaction are skipped by the other rather than blocking it,
 * so a slow run also cannot stall the whole queue.
 *
 * The claim marks each row by moving `nextRunAt` forward inside the same
 * transaction, so it is no longer due the moment the lock is released.
 */
export async function claimDueSchedules(limit = 25): Promise<Schedule[]> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, 'active'),
          sql`${schedules.nextRunAt} is not null`,
          lte(schedules.nextRunAt, now),
        ),
      )
      .orderBy(schedules.nextRunAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    const claimed: Schedule[] = [];

    for (const schedule of due) {
      // Compute the next due time now, while the row is locked, so a crash
      // mid-execution cannot leave the row permanently due and re-firing.
      const advanced = advance(schedule, now);

      const [updated] = await tx
        .update(schedules)
        .set({
          nextRunAt: advanced.nextRunAt,
          status: advanced.status,
          lastRunAt: now,
          updatedAt: now,
        })
        .where(eq(schedules.id, schedule.id))
        .returning();

      // The pre-claim snapshot is returned: the runner needs the due time this
      // firing was for, not the one after it.
      if (updated) claimed.push(schedule);
    }

    return claimed;
  });
}

/**
 * Work out where a schedule goes after firing.
 *
 * A one-shot completes. A recurring one moves to its next occurrence, skipping
 * any that were missed while nothing was running, and completes once it has
 * reached `maxRuns`.
 */
function advance(
  schedule: Schedule,
  now: Date,
): { nextRunAt: Date | null; status: 'active' | 'completed' } {
  const runsAfterThis = schedule.runCount + 1;

  if (schedule.maxRuns !== null && runsAfterThis >= schedule.maxRuns) {
    return { nextRunAt: null, status: 'completed' };
  }

  if (!schedule.cron) {
    // One-shot: nothing follows it.
    return { nextRunAt: null, status: 'completed' };
  }

  const from = schedule.nextRunAt ?? now;
  const { next } = skipMissed(schedule.cron, schedule.timezone, from, now);
  return { nextRunAt: next, status: 'active' };
}

/* -------------------------------------------------------------------------- */
/* Run records                                                                */
/* -------------------------------------------------------------------------- */

export async function startRun(schedule: Schedule, scheduledFor: Date): Promise<ScheduleRun> {
  const [run] = await db
    .insert(scheduleRuns)
    .values({
      scheduleId: schedule.id,
      userId: schedule.userId,
      status: 'running',
      scheduledFor,
    })
    .returning();

  if (!run) throw new Error('Failed to record the schedule run');
  return run;
}

export async function finishRun(
  runId: string,
  outcome: { status: 'succeeded' | 'failed' | 'skipped'; output?: string; error?: string },
): Promise<void> {
  await db
    .update(scheduleRuns)
    .set({
      status: outcome.status,
      finishedAt: new Date(),
      output: outcome.output?.slice(0, 20_000) ?? null,
      error: outcome.error?.slice(0, 2000) ?? null,
    })
    .where(eq(scheduleRuns.id, runId));
}

/** Consecutive failures pause a schedule, so a broken one stops burning tokens. */
const FAILURE_LIMIT = 5;

export async function recordOutcome(
  scheduleId: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    await db
      .update(schedules)
      .set({
        runCount: sql`${schedules.runCount} + 1`,
        consecutiveFailures: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, scheduleId));
    return;
  }

  // A schedule failing every time is not going to fix itself, and each attempt
  // on an agent_run costs tokens. Pausing after a few failures makes it the
  // user's decision to resume rather than a silent recurring charge.
  await db
    .update(schedules)
    .set({
      runCount: sql`${schedules.runCount} + 1`,
      consecutiveFailures: sql`${schedules.consecutiveFailures} + 1`,
      lastError: outcome.error.slice(0, 2000),
      status: sql`case
        when ${schedules.consecutiveFailures} + 1 >= ${FAILURE_LIMIT} then 'failed'::schedule_status
        else ${schedules.status}
      end`,
      updatedAt: new Date(),
    })
    .where(eq(schedules.id, scheduleId));
}

export async function recentRuns(
  userId: string,
  options: { scheduleId?: string; limit?: number } = {},
): Promise<ScheduleRun[]> {
  const filters = [eq(scheduleRuns.userId, userId)];
  if (options.scheduleId) filters.push(eq(scheduleRuns.scheduleId, options.scheduleId));

  return db
    .select()
    .from(scheduleRuns)
    .where(and(...filters))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(Math.min(options.limit ?? 20, 100));
}

/** A run plus the title of the schedule it came from. */
export interface UnreadRun {
  id: string;
  scheduleId: string;
  title: string;
  kind: ScheduleKind;
  status: ScheduleRun['status'];
  startedAt: Date;
  output: string | null;
  error: string | null;
}

/**
 * Runs the user has not seen yet.
 *
 * Joined to the schedule so the caller has the title: "your morning briefing
 * ran" is useful, an unlabelled block of output is not. A still-running row is
 * excluded, since there is nothing to report about it yet.
 */
export async function unreadRuns(userId: string, limit = 20): Promise<UnreadRun[]> {
  return db
    .select({
      id: scheduleRuns.id,
      scheduleId: scheduleRuns.scheduleId,
      title: schedules.title,
      kind: schedules.kind,
      status: scheduleRuns.status,
      startedAt: scheduleRuns.startedAt,
      output: scheduleRuns.output,
      error: scheduleRuns.error,
    })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(
      and(
        eq(scheduleRuns.userId, userId),
        isNull(scheduleRuns.acknowledgedAt),
        sql`${scheduleRuns.status} in ('succeeded', 'failed')`,
      ),
    )
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(Math.min(limit, 100));
}

export async function acknowledgeRuns(userId: string, runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const updated = await db
    .update(scheduleRuns)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(scheduleRuns.userId, userId), inArray(scheduleRuns.id, runIds)))
    .returning({ id: scheduleRuns.id });
  return updated.length;
}
