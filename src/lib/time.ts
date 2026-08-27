/**
 * Timezone-aware date helpers.
 *
 * The agent reasons about "tomorrow" and "next Tuesday" constantly, and every
 * one of those has to resolve in the user's timezone rather than the server's.
 * These helpers are the single place that conversion happens.
 */

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Render an instant in the user's timezone, for prompts and tool results. */
export function formatInTimezone(
  date: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: timezone }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** The calendar date (YYYY-MM-DD) that an instant falls on in a timezone. */
export function calendarDateIn(date: Date, timezone: string): string {
  try {
    // en-CA gives ISO-ordered output, so no manual part assembly is needed.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Describe how far away an instant is, in plain language.
 *
 * Used in task listings so the model does not have to do date arithmetic on
 * every row — that is exactly the sort of thing it gets subtly wrong.
 */
export function describeRelative(target: Date, now = new Date()): string {
  const deltaMs = target.getTime() - now.getTime();
  const overdue = deltaMs < 0;
  const absMinutes = Math.round(Math.abs(deltaMs) / 60_000);

  const phrase = (() => {
    if (absMinutes < 1) return 'now';
    if (absMinutes < 60) return `${absMinutes} minute${absMinutes === 1 ? '' : 's'}`;
    const hours = Math.round(absMinutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
    const weeks = Math.round(days / 7);
    if (weeks < 9) return `${weeks} week${weeks === 1 ? '' : 's'}`;
    const months = Math.round(days / 30);
    return `${months} month${months === 1 ? '' : 's'}`;
  })();

  if (phrase === 'now') return 'right now';
  return overdue ? `${phrase} overdue` : `in ${phrase}`;
}

/**
 * Find the instant at which a given local wall-clock time occurs in a timezone.
 *
 * There is no standard API for this, so the offset is measured by formatting a
 * guess back into the target zone and correcting by the observed error. One
 * correction is enough for every real offset; the second pass catches the DST
 * boundary case where the first correction crosses a transition.
 */
export function anchorLocalTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = wanted;

  for (let pass = 0; pass < 2; pass += 1) {
    const observed = localFieldsAsUtc(new Date(guess), timezone);
    const error = observed - wanted;
    if (error === 0) break;
    guess -= error;
  }

  return new Date(guess);
}

/** Read an instant's local calendar fields back as a UTC-based timestamp. */
function localFieldsAsUtc(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? '0';
    return Number.parseInt(value, 10);
  };

  // Intl renders midnight as hour 24 in some locales/zones; normalise it.
  const hour = field('hour') % 24;

  return Date.UTC(field('year'), field('month') - 1, field('day'), hour, field('minute'), field('second'));
}
