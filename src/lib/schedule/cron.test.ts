import { describe, expect, it } from 'vitest';

import { InvalidScheduleError, checkCron, describeCron, nextOccurrence, skipMissed } from './cron';

const iso = (date: Date) => date.toISOString();

describe('checkCron', () => {
  it('resolves weekday 09:00 in Asia/Kolkata to 03:30 UTC', () => {
    const { upcoming } = checkCron('0 9 * * 1-5', 'Asia/Kolkata', new Date('2026-08-27T00:00:00Z'));
    expect(iso(upcoming[0]!)).toBe('2026-08-27T03:30:00.000Z');
  });

  it('skips the weekend', () => {
    const { upcoming } = checkCron('0 9 * * 1-5', 'Asia/Kolkata', new Date('2026-08-27T00:00:00Z'));
    // Thursday, Friday, then Monday.
    expect(iso(upcoming[2]!)).toBe('2026-08-31T03:30:00.000Z');
  });

  it.each([
    ['nonsense', 'not a cron expression at all'],
    ['0 9 * *', 'four fields'],
    ['0 9 * * * *', 'six fields'],
    ['99 9 * * *', 'minute out of range'],
    ['0 99 * * *', 'hour out of range'],
    ['', 'empty'],
  ])('rejects %s (%s)', (expression) => {
    expect(() => checkCron(expression, 'UTC')).toThrow(InvalidScheduleError);
  });

  it('rejects an invalid timezone', () => {
    expect(() => checkCron('0 9 * * *', 'Not/AZone')).toThrow(InvalidScheduleError);
  });

  it.each(['* * * * *', '*/2 * * * *', '*/4 * * * *'])(
    'rejects %s as too frequent',
    (expression) => {
      // The agent writing this by accident is plausible, and on an agent run
      // each firing costs tokens.
      expect(() => checkCron(expression, 'UTC')).toThrow(/five minutes/);
    },
  );

  it.each(['*/5 * * * *', '*/15 * * * *', '0 * * * *', '0 9 * * *'])(
    'allows %s',
    (expression) => {
      expect(checkCron(expression, 'UTC').upcoming).toHaveLength(5);
    },
  );
});

describe('nextOccurrence and daylight saving', () => {
  it('is 08:00 UTC for 09:00 Berlin in winter', () => {
    expect(iso(nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-01-10T00:00:00Z')))).toBe(
      '2026-01-10T08:00:00.000Z',
    );
  });

  it('is 07:00 UTC for 09:00 Berlin in summer', () => {
    expect(iso(nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-07-10T00:00:00Z')))).toBe(
      '2026-07-10T07:00:00.000Z',
    );
  });

  it('flips the offset on the fall-back day itself', () => {
    expect(iso(nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-10-24T08:00:00Z')))).toBe(
      '2026-10-25T08:00:00.000Z',
    );
  });

  it('flips the offset on the spring-forward day itself', () => {
    expect(iso(nextOccurrence('0 9 * * *', 'Europe/Berlin', new Date('2026-03-28T08:00:00Z')))).toBe(
      '2026-03-29T07:00:00.000Z',
    );
  });

  it('is strictly after the given time, so a schedule cannot re-fire itself', () => {
    const at = new Date('2026-08-27T09:00:00Z');
    expect(nextOccurrence('0 9 * * *', 'UTC', at).getTime()).toBeGreaterThan(at.getTime());
  });

  it('handles a southern-hemisphere zone, where the transitions are inverted', () => {
    // Sydney is UTC+11 in January and UTC+10 in July. Both `from` instants are
    // already past 09:00 local, so the next firing is the following morning:
    // 22:00Z in January and 23:00Z in July, an hour apart because of the offset.
    expect(iso(nextOccurrence('0 9 * * *', 'Australia/Sydney', new Date('2026-01-10T00:00:00Z')))).toBe(
      '2026-01-10T22:00:00.000Z',
    );
    expect(iso(nextOccurrence('0 9 * * *', 'Australia/Sydney', new Date('2026-07-10T00:00:00Z')))).toBe(
      '2026-07-10T23:00:00.000Z',
    );
  });
});

describe('skipMissed', () => {
  it('skips a backlog rather than replaying it', () => {
    // Three days of downtime should not fire a daily schedule three times.
    const result = skipMissed(
      '0 9 * * *',
      'UTC',
      new Date('2026-08-20T09:00:00Z'),
      new Date('2026-08-23T12:00:00Z'),
    );
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(iso(result.next)).toBe('2026-08-24T09:00:00.000Z');
  });

  it('always lands in the future', () => {
    const now = new Date('2026-08-23T12:00:00Z');
    expect(skipMissed('0 9 * * *', 'UTC', new Date('2020-01-01T00:00:00Z'), now).next.getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  it('skips nothing when the last firing just happened', () => {
    const result = skipMissed(
      '0 9 * * *',
      'UTC',
      new Date('2026-08-23T09:00:00Z'),
      new Date('2026-08-23T09:00:30Z'),
    );
    expect(result.skipped).toBe(0);
  });

  it('still lands in the future on a gap too large to walk', () => {
    // 36 years of daily firings exhausts the walk bound. Returning the date it
    // reached would leave the schedule permanently overdue, re-firing on every
    // tick, so it resolves from `now` instead.
    const now = new Date('2026-08-23T12:00:00Z');
    const result = skipMissed('0 9 * * *', 'UTC', new Date('1990-01-01T00:00:00Z'), now);
    expect(result.next.getTime()).toBeGreaterThan(now.getTime());
    expect(iso(result.next)).toBe('2026-08-24T09:00:00.000Z');
  });

  it('keeps the original cadence rather than shifting it', () => {
    // A weekday schedule must resume on a weekday, not on whatever day the
    // outage ended.
    const result = skipMissed(
      '0 9 * * 1-5',
      'UTC',
      new Date('2026-08-26T09:00:00Z'),
      new Date('2026-08-29T12:00:00Z'),
    );
    // 2026-08-29 is a Saturday, so the next firing is Monday the 31st.
    expect(iso(result.next)).toBe('2026-08-31T09:00:00.000Z');
  });
});

describe('describeCron', () => {
  it('describes a daily schedule', () => {
    expect(describeCron('0 9 * * *', 'Europe/Berlin')).toBe('every day at 09:00 Europe/Berlin');
  });

  it('describes a weekday schedule', () => {
    expect(describeCron('30 7 * * 1-5', 'UTC')).toBe('every weekday at 07:30 UTC');
  });

  it('describes a single weekday', () => {
    expect(describeCron('0 18 * * 5', 'UTC')).toBe('every Friday at 18:00 UTC');
  });

  it('falls back to the expression for anything elaborate', () => {
    // A guessed English rendering of a complex cron is easy to get subtly wrong,
    // and a wrong description is worse than none.
    expect(describeCron('*/15 9-17 1,15 * *', 'UTC')).toContain('*/15 9-17 1,15 * *');
  });
});
