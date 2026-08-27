import { CronExpressionParser } from 'cron-parser';

import { isValidTimezone } from '@/lib/time';

/**
 * Cron evaluation, always in the user's timezone.
 *
 * A reminder set for "weekdays at 9" means 9 in the user's morning, not 9 UTC,
 * and it has to keep meaning that across a daylight-saving change. That is why
 * the timezone is stored on the schedule and passed on every evaluation rather
 * than being resolved once at creation time into a fixed UTC offset — an offset
 * captured in July is wrong in December.
 */

export class InvalidScheduleError extends Error {}

/** Sanity floor on frequency: a per-minute schedule is a runaway, not a plan. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface CronCheck {
  /** Human-readable next few firings, so the agent can confirm what it set up. */
  upcoming: Date[];
}

/**
 * Validate a cron expression and return its next firings.
 *
 * Rejects anything that would fire more often than every five minutes: the
 * agent writing `* * * * *` by accident is a plausible mistake with an
 * expensive outcome, since an `agent_run` schedule spends tokens on every fire.
 */
export function checkCron(expression: string, timezone: string, from = new Date()): CronCheck {
  if (!isValidTimezone(timezone)) {
    throw new InvalidScheduleError(`"${timezone}" is not a valid IANA timezone.`);
  }

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidScheduleError(
      `A cron expression needs exactly five fields (minute hour day month weekday); got ${fields.length}.`,
    );
  }

  let upcoming: Date[];
  try {
    const iterator = CronExpressionParser.parse(expression, { currentDate: from, tz: timezone });
    upcoming = Array.from({ length: 5 }, () => iterator.next().toDate());
  } catch (error) {
    throw new InvalidScheduleError(
      `That cron expression is not valid: ${error instanceof Error ? error.message : error}`,
    );
  }

  const [first, second] = upcoming;
  if (first && second && second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
    throw new InvalidScheduleError(
      'That fires more often than every five minutes. Use a less frequent schedule.',
    );
  }

  return { upcoming };
}

/**
 * The next firing strictly after `after`.
 *
 * Strictly after matters: computing the next run from the time a schedule just
 * fired must not return that same instant, or the schedule fires forever in a
 * tight loop.
 */
export function nextOccurrence(
  expression: string,
  timezone: string,
  after: Date = new Date(),
): Date {
  try {
    const iterator = CronExpressionParser.parse(expression, {
      // cron-parser's `next()` is exclusive of `currentDate`, so passing the
      // last fire time directly gives the following occurrence.
      currentDate: after,
      tz: timezone,
    });
    return iterator.next().toDate();
  } catch (error) {
    throw new InvalidScheduleError(
      `Could not compute the next run: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Advance a schedule past any firings that were missed while nothing was running.
 *
 * A daily schedule that was due while the app was down for three days should
 * fire once and then resume its normal cadence — not fire three times in a row
 * to "catch up". Replaying a backlog of agent runs would spend tokens on stale
 * work and bury the user in notifications about mornings that have passed.
 *
 * Returns the next occurrence at or after now, plus how many were skipped.
 */
export function skipMissed(
  expression: string,
  timezone: string,
  from: Date,
  now: Date = new Date(),
): { next: Date; skipped: number } {
  let candidate = nextOccurrence(expression, timezone, from);
  let skipped = 0;

  // Bounded so a pathological expression cannot spin: 4000 iterations covers
  // more than a decade of daily runs, and far more than any real outage.
  while (candidate <= now && skipped < 4000) {
    candidate = nextOccurrence(expression, timezone, candidate);
    skipped += 1;
  }

  return { next: candidate, skipped };
}

/** Plain-language description of a cron, for confirming back to the user. */
export function describeCron(expression: string, timezone: string): string {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, weekday] = fields;

  const time =
    minute !== undefined && hour !== undefined && /^\d+$/.test(minute) && /^\d+$/.test(hour)
      ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
      : undefined;

  const everyDay = dayOfMonth === '*' && month === '*' && weekday === '*';
  const weekdaysOnly = dayOfMonth === '*' && month === '*' && weekday === '1-5';

  if (time && everyDay) return `every day at ${time} ${timezone}`;
  if (time && weekdaysOnly) return `every weekday at ${time} ${timezone}`;
  if (time && weekday !== undefined && /^[0-6]$/.test(weekday)) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `every ${names[Number.parseInt(weekday, 10)]} at ${time} ${timezone}`;
  }

  // Anything more elaborate is described by its next firing rather than by a
  // guessed English rendering, which is easy to get subtly wrong.
  return `on the schedule "${expression}" (${timezone})`;
}
