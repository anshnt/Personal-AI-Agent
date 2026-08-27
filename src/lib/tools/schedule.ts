import { tool } from 'ai';
import { z } from 'zod';

import { describeRelative, formatInTimezone } from '@/lib/time';
import type { Schedule, ScheduleRun } from '@/lib/db/schema';
import { InvalidScheduleError, checkCron, describeCron } from '@/lib/schedule/cron';
import {
  acknowledgeRuns,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  recentRuns,
  unreadRuns,
  updateSchedule,
} from '@/lib/schedule/store';
import { failure, instrument, type AgentContext } from './context';
import { id, isoDateTime } from './schemas';

export function scheduleTools(context: AgentContext) {
  const timezone = context.user.timezone;

  const render = (schedule: Schedule) => ({
    schedule_id: schedule.id,
    title: schedule.title,
    kind: schedule.kind,
    what_it_does: schedule.payload,
    repeats: schedule.cron ? describeCron(schedule.cron, schedule.timezone) : 'once',
    status: schedule.status,
    next_run_at: schedule.nextRunAt?.toISOString() ?? null,
    next_run_local: schedule.nextRunAt
      ? formatInTimezone(schedule.nextRunAt, schedule.timezone)
      : null,
    next_run_relative: schedule.nextRunAt ? describeRelative(schedule.nextRunAt) : null,
    last_run_at: schedule.lastRunAt?.toISOString() ?? null,
    times_run: schedule.runCount,
    max_runs: schedule.maxRuns,
    last_error: schedule.lastError,
  });

  const renderRun = (run: ScheduleRun) => ({
    run_id: run.id,
    schedule_id: run.scheduleId,
    schedule_title: null as string | null,
    status: run.status,
    due_at: run.scheduledFor.toISOString() as string | null,
    ran_at: run.startedAt.toISOString(),
    ran_local: formatInTimezone(run.startedAt, timezone),
    output: run.output,
    error: run.error,
    seen: run.acknowledgedAt !== null,
  });

  return {
    schedule_reminder: tool({
      description:
        "Set something to surface to the user at a time. Use it when they ask to be reminded. Give either run_at for a one-off or cron for something repeating. Call resolve_date first to turn \"tomorrow at 9\" into a real timestamp.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe('Short name for the schedule itself.'),
        message: z
          .string()
          .min(1)
          .max(2000)
          .describe('What to show when it fires. Write it so it makes sense with no context.'),
        run_at: isoDateTime.optional().describe('For a one-off. Absolute ISO 8601.'),
        cron: z
          .string()
          .max(120)
          .optional()
          .describe(
            'For something repeating. Five fields: minute hour day month weekday. Evaluated in the user\'s timezone. Example: "0 9 * * 1-5" is weekdays at 09:00.',
          ),
        max_runs: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Stop after this many firings. Omit for indefinitely.'),
      }),
      execute: instrument('schedule_reminder', context, async (input) =>
        create(input, 'reminder', input.message),
      ),
    }),

    schedule_agent_run: tool({
      description:
        'Schedule work for yourself to do later, unattended, with all your tools available. Use this for standing jobs: "every weekday at 8, check my mail for anything urgent and add it to my list". Write the prompt as an instruction to yourself, because nobody will be there to clarify it.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        prompt: z
          .string()
          .min(10)
          .max(4000)
          .describe(
            'The instruction to run. Be specific about what to look at and what to produce, since you will have no conversation for context.',
          ),
        run_at: isoDateTime.optional(),
        cron: z.string().max(120).optional(),
        max_runs: z.number().int().min(1).max(1000).optional(),
      }),
      execute: instrument('schedule_agent_run', context, async (input) =>
        create(input, 'agent_run', input.prompt),
      ),
    }),

    list_schedules: tool({
      description:
        'List the schedules that exist, with when each next fires. Use it when the user asks what is scheduled, or before changing something they referred to by name.',
      inputSchema: z.object({
        include_inactive: z
          .boolean()
          .default(false)
          .describe('Also show paused, completed, and failed schedules.'),
      }),
      execute: instrument('list_schedules', context, async (input) => {
        const rows = await listSchedules(context.user.id, {
          includeInactive: input.include_inactive,
        });
        return { ok: true as const, count: rows.length, schedules: rows.map(render) };
      }),
    }),

    update_schedule: tool({
      description:
        'Change, pause, or resume a schedule. Only the fields you pass change. Pausing keeps it; use delete_schedule to remove it. Resuming recomputes the next firing, so a schedule paused for a week will not fire immediately.',
      inputSchema: z.object({
        schedule_id: id,
        title: z.string().min(1).max(200).optional(),
        payload: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe('New reminder text or new prompt.'),
        cron: z.string().max(120).nullable().optional(),
        run_at: isoDateTime.nullable().optional(),
        status: z.enum(['active', 'paused']).optional(),
        max_runs: z.number().int().min(1).max(1000).nullable().optional(),
      }),
      execute: instrument('update_schedule', context, async (input) => {
        try {
          const updated = await updateSchedule(context.user.id, input.schedule_id, {
            title: input.title,
            payload: input.payload,
            cron: input.cron,
            runAt: input.run_at === undefined ? undefined : input.run_at === null ? null : new Date(input.run_at),
            status: input.status,
            maxRuns: input.max_runs,
          });

          if (!updated) return failure('No schedule with that id belongs to this user.');
          return { ok: true as const, schedule: render(updated) };
        } catch (error) {
          if (error instanceof InvalidScheduleError) return failure(error.message);
          throw error;
        }
      }),
    }),

    delete_schedule: tool({
      description:
        'Delete a schedule permanently. Prefer pausing it with update_schedule unless the user wants it gone.',
      inputSchema: z.object({ schedule_id: id }),
      execute: instrument('delete_schedule', context, async (input) => {
        const deleted = await deleteSchedule(context.user.id, input.schedule_id);
        return deleted
          ? { ok: true as const, deleted: true }
          : failure('No schedule with that id belongs to this user.');
      }),
    }),

    schedule_history: tool({
      description:
        'Read what scheduled runs actually produced. Use it when the user asks whether something ran, what a morning job found, or why a schedule stopped working.',
      inputSchema: z.object({
        schedule_id: id.optional().describe('Omit for every schedule.'),
        only_unseen: z
          .boolean()
          .default(false)
          .describe('Only runs the user has not been shown yet.'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: instrument('schedule_history', context, async (input) => {
        if (input.schedule_id) {
          const owned = await getSchedule(context.user.id, input.schedule_id);
          if (!owned) return failure('No schedule with that id belongs to this user.');
        }

        // The two sources differ in shape — unread rows carry the schedule
        // title from a join — so both are flattened to one reported shape.
        const runs = input.only_unseen
          ? (await unreadRuns(context.user.id, input.limit)).map((run) => ({
              run_id: run.id,
              schedule_id: run.scheduleId,
              schedule_title: run.title,
              status: run.status,
              due_at: null,
              ran_at: run.startedAt.toISOString(),
              ran_local: formatInTimezone(run.startedAt, timezone),
              output: run.output,
              error: run.error,
              seen: false,
            }))
          : (
              await recentRuns(context.user.id, {
                scheduleId: input.schedule_id,
                limit: input.limit,
              })
            ).map(renderRun);

        return { ok: true as const, count: runs.length, runs };
      }),
    }),

    mark_runs_seen: tool({
      description:
        'Mark scheduled run results as shown to the user, so they are not surfaced again. Call this after you have actually told them what a run produced.',
      inputSchema: z.object({
        run_ids: z.array(id).min(1).max(50),
      }),
      execute: instrument('mark_runs_seen', context, async (input) => {
        const marked = await acknowledgeRuns(context.user.id, input.run_ids);
        return { ok: true as const, marked };
      }),
    }),
  };

  async function create(
    input: { title: string; run_at?: string; cron?: string; max_runs?: number },
    kind: 'reminder' | 'agent_run',
    payload: string,
  ) {
    try {
      // Checked before storing so the failure names the problem, and so the
      // upcoming firings can be reported back for the user to sanity-check.
      const upcoming = input.cron
        ? checkCron(input.cron, timezone).upcoming
        : [];

      const created = await createSchedule({
        userId: context.user.id,
        title: input.title,
        kind,
        payload,
        cron: input.cron,
        runAt: input.run_at ? new Date(input.run_at) : undefined,
        timezone,
        maxRuns: input.max_runs,
        sourceConversationId: context.conversationId,
      });

      return {
        ok: true as const,
        schedule: render(created),
        // Confirming the concrete firings back is what catches a cron the model
        // wrote slightly wrong, while the user is still in the conversation.
        next_firings: (upcoming.length > 0 ? upcoming : created.nextRunAt ? [created.nextRunAt] : [])
          .slice(0, 3)
          .map((date) => formatInTimezone(date, timezone)),
      };
    } catch (error) {
      if (error instanceof InvalidScheduleError) return failure(error.message);
      throw error;
    }
  }
}
