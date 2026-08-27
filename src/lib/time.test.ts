import { describe, expect, it } from 'vitest';

import { anchorLocalTime, calendarDateIn, describeRelative, formatInTimezone, isValidTimezone } from './time';

/**
 * Timezone maths, which is where a scheduling feature quietly goes wrong. Every
 * case below has broken a naive implementation: half- and quarter-hour offsets,
 * both sides of a DST transition, the transition day itself, midnight (which
 * Intl renders as hour 24 in some zones), and UTC+14.
 */

describe('anchorLocalTime', () => {
  it.each([
    ['Asia/Kolkata at UTC+5:30', 2026, 3, 15, 9, 0, 'Asia/Kolkata', '2026-03-15T03:30:00.000Z'],
    ['Asia/Kathmandu at UTC+5:45', 2026, 3, 15, 9, 0, 'Asia/Kathmandu', '2026-03-15T03:15:00.000Z'],
    ['Europe/Berlin in winter', 2026, 1, 15, 9, 0, 'Europe/Berlin', '2026-01-15T08:00:00.000Z'],
    ['Europe/Berlin in summer', 2026, 7, 15, 9, 0, 'Europe/Berlin', '2026-07-15T07:00:00.000Z'],
    ['Europe/Berlin on the spring-forward day', 2026, 3, 29, 9, 0, 'Europe/Berlin', '2026-03-29T07:00:00.000Z'],
    ['Europe/Berlin on the fall-back day', 2026, 10, 25, 9, 0, 'Europe/Berlin', '2026-10-25T08:00:00.000Z'],
    ['America/Los_Angeles in winter', 2026, 1, 15, 9, 0, 'America/Los_Angeles', '2026-01-15T17:00:00.000Z'],
    ['America/Los_Angeles in summer', 2026, 7, 15, 9, 0, 'America/Los_Angeles', '2026-07-15T16:00:00.000Z'],
    ['Pacific/Auckland at midnight', 2026, 7, 15, 0, 0, 'Pacific/Auckland', '2026-07-14T12:00:00.000Z'],
    ['UTC at midnight', 2026, 7, 15, 0, 0, 'UTC', '2026-07-15T00:00:00.000Z'],
    ['Pacific/Kiritimati at UTC+14', 2026, 7, 15, 9, 0, 'Pacific/Kiritimati', '2026-07-14T19:00:00.000Z'],
    ['Australia/Adelaide at UTC+10:30', 2026, 1, 15, 9, 0, 'Australia/Adelaide', '2026-01-14T22:30:00.000Z'],
  ])('resolves 09:00 %s', (_label, year, month, day, hour, minute, zone, expected) => {
    expect(anchorLocalTime(year, month, day, hour, minute, zone).toISOString()).toBe(expected);
  });

  it('round trips: the anchored instant reads back as the requested wall time', () => {
    const zones = [
      'Asia/Kolkata',
      'Europe/Berlin',
      'America/Los_Angeles',
      'Pacific/Auckland',
      'Asia/Kathmandu',
      'America/St_Johns',
      'UTC',
    ];
    const moments: Array<[number, number, number]> = [
      [1, 15, 9],
      [3, 29, 14],
      [7, 4, 0],
      [10, 25, 23],
      [12, 31, 17],
    ];

    for (const zone of zones) {
      for (const [month, day, hour] of moments) {
        const at = anchorLocalTime(2026, month, day, hour, 30, zone);
        const expectedDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        expect(calendarDateIn(at, zone), `${zone} ${expectedDate}`).toBe(expectedDate);
        expect(
          formatInTimezone(at, zone, { hour: '2-digit', minute: '2-digit', hour12: false }),
          `${zone} ${expectedDate} ${hour}:30`,
        ).toContain(String(hour).padStart(2, '0'));
      }
    }
  });
});

describe('isValidTimezone', () => {
  it('accepts real zones', () => {
    for (const zone of ['UTC', 'Europe/Berlin', 'Asia/Kolkata', 'America/Sao_Paulo']) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
  });

  it('rejects nonsense', () => {
    for (const zone of ['Not/AZone', 'Mars/Olympus', '', 'Europe//Berlin']) {
      expect(isValidTimezone(zone), zone).toBe(false);
    }
  });
});

describe('calendarDateIn', () => {
  it('returns the local date, not the UTC one', () => {
    // 22:30 UTC is already the next day in Kolkata.
    const instant = new Date('2026-08-27T22:30:00Z');
    expect(calendarDateIn(instant, 'UTC')).toBe('2026-08-27');
    expect(calendarDateIn(instant, 'Asia/Kolkata')).toBe('2026-08-28');
    expect(calendarDateIn(instant, 'America/Los_Angeles')).toBe('2026-08-27');
  });

  it('degrades rather than throwing on an invalid zone', () => {
    expect(calendarDateIn(new Date('2026-08-27T00:00:00Z'), 'Not/AZone')).toBe('2026-08-27');
  });
});

describe('describeRelative', () => {
  const now = new Date('2026-08-27T12:00:00Z');

  it.each([
    [30_000, 'right now'],
    [5 * 60_000, 'in 5 minutes'],
    [60 * 60_000, 'in 1 hour'],
    [3 * 3_600_000, 'in 3 hours'],
    [2 * 86_400_000, 'in 2 days'],
    [21 * 86_400_000, 'in 3 weeks'],
    [90 * 86_400_000, 'in 3 months'],
  ])('describes +%dms as "%s"', (delta, expected) => {
    expect(describeRelative(new Date(now.getTime() + delta), now)).toBe(expected);
  });

  it('labels overdue times', () => {
    expect(describeRelative(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3 hours overdue');
    expect(describeRelative(new Date(now.getTime() - 2 * 86_400_000), now)).toBe('2 days overdue');
  });

  it('uses the singular where it should', () => {
    expect(describeRelative(new Date(now.getTime() + 60_000), now)).toBe('in 1 minute');
    expect(describeRelative(new Date(now.getTime() + 86_400_000), now)).toBe('in 1 day');
  });
});
