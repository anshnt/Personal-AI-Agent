import { tool } from 'ai';
import { z } from 'zod';

import { anchorLocalTime, calendarDateIn, formatInTimezone, isValidTimezone } from '@/lib/time';
import { failure, instrument, type AgentContext } from './context';

/**
 * Date arithmetic as a tool rather than a prompt instruction.
 *
 * Resolving "the Friday after next" by reasoning is exactly the kind of thing
 * models get subtly wrong, and a wrong due date on a reminder is worse than a
 * slow one. Giving it a deterministic resolver removes the whole class of error.
 */
export function timeTools(context: AgentContext) {
  return {
    resolve_date: tool({
      description:
        "Convert a relative date expression into absolute timestamps in the user's timezone. Use this before setting any due date or reminder from a phrase like \"tomorrow at 9\", \"next Tuesday\", or \"in three weeks\".",
      inputSchema: z.object({
        days_from_now: z
          .number()
          .int()
          .min(-3650)
          .max(3650)
          .default(0)
          .describe('Whole days to shift from today. Use 0 for today, 1 for tomorrow.'),
        weekday: z
          .enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
          .optional()
          .describe(
            'Snap forward to the next occurrence of this weekday, applied after days_from_now.',
          ),
        time: z
          .string()
          .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use 24-hour HH:MM.')
          .optional()
          .describe("Local wall-clock time in the user's timezone. Defaults to 09:00."),
        timezone: z
          .string()
          .optional()
          .describe("Override the user's timezone. Rarely needed."),
      }),
      execute: instrument('resolve_date', context, async (input) => {
        const timezone = input.timezone ?? context.user.timezone;
        if (!isValidTimezone(timezone)) {
          return failure(`"${timezone}" is not a valid IANA timezone.`);
        }

        const now = new Date();
        const todayLocal = calendarDateIn(now, timezone);
        const parts = todayLocal.split('-').map((part) => Number.parseInt(part, 10));
        const [year, month, day] = parts;
        if (year === undefined || month === undefined || day === undefined) {
          return failure(`Could not read today's date in ${timezone}.`);
        }

        // Walk the calendar in UTC to avoid DST arithmetic, then re-anchor the
        // result to the correct instant for the requested local wall time.
        const cursor = new Date(Date.UTC(year, month - 1, day));
        cursor.setUTCDate(cursor.getUTCDate() + input.days_from_now);

        if (input.weekday) {
          const target = [
            'sunday',
            'monday',
            'tuesday',
            'wednesday',
            'thursday',
            'friday',
            'saturday',
          ].indexOf(input.weekday);
          // Always move forward, and never land on the same day the caller
          // started from — "next Tuesday" said on a Tuesday means the next one.
          const delta = (target - cursor.getUTCDay() + 7) % 7 || 7;
          cursor.setUTCDate(cursor.getUTCDate() + delta);
        }

        const time = input.time ?? '09:00';
        const [hourText, minuteText] = time.split(':');
        const hour = Number.parseInt(hourText ?? '9', 10);
        const minute = Number.parseInt(minuteText ?? '0', 10);

        const resolved = anchorLocalTime(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth() + 1,
          cursor.getUTCDate(),
          hour,
          minute,
          timezone,
        );

        return {
          ok: true as const,
          iso: resolved.toISOString(),
          local: formatInTimezone(resolved, timezone, {
            weekday: 'long',
            dateStyle: undefined,
            timeStyle: undefined,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
          calendar_date: calendarDateIn(resolved, timezone),
          timezone,
        };
      }),
    }),

    current_time: tool({
      description:
        "Get the current time in the user's timezone. The system prompt already carries this, so only call it if a turn is running long enough that it may have drifted.",
      inputSchema: z.object({}),
      execute: instrument('current_time', context, async () => {
        const now = new Date();
        return {
          ok: true as const,
          iso: now.toISOString(),
          local: formatInTimezone(now, context.user.timezone, {
            dateStyle: 'full',
            timeStyle: 'short',
          }),
          timezone: context.user.timezone,
        };
      }),
    }),
  };
}
