import { generateText, stepCountIs } from 'ai';
import { eq } from 'drizzle-orm';

import { buildSystemPrompt } from '@/lib/ai/prompts';
import { agentModel, agentProviderOptions } from '@/lib/ai/provider';
import { db } from '@/lib/db';
import { users, type Schedule, type User } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { recall } from '@/lib/memory/store';
import { openTaskSummaries } from '@/lib/tasks/store';
import { formatInTimezone } from '@/lib/time';
import { buildTools } from '@/lib/tools';
import {
  claimDueSchedules,
  finishRun,
  recordOutcome,
  startRun,
} from './store';

/**
 * Execute the schedules that are due.
 *
 * Called from `/api/cron`, which an external scheduler pings. Nothing here
 * assumes it is the only caller: claiming is atomic, so overlapping pings and
 * multiple instances are safe.
 */

export interface TickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  outcomes: Array<{
    scheduleId: string;
    title: string;
    kind: string;
    ok: boolean;
    output?: string;
    error?: string;
  }>;
}

/** Bound on tool-calling steps for a scheduled run. */
const SCHEDULED_STEP_LIMIT = 16;

export async function tick(options: { limit?: number } = {}): Promise<TickResult> {
  const claimed = await claimDueSchedules(options.limit ?? 25);

  const result: TickResult = { claimed: claimed.length, succeeded: 0, failed: 0, outcomes: [] };

  // Sequentially rather than in parallel: a burst of concurrent agent runs is a
  // burst of concurrent model calls, and the whole point of a background tick is
  // that it does not need to be fast.
  for (const schedule of claimed) {
    const scheduledFor = schedule.nextRunAt ?? new Date();
    const run = await startRun(schedule, scheduledFor);

    try {
      const output = await execute(schedule);
      await finishRun(run.id, { status: 'succeeded', output });
      await recordOutcome(schedule.id, { ok: true });
      result.succeeded += 1;
      result.outcomes.push({
        scheduleId: schedule.id,
        title: schedule.title,
        kind: schedule.kind,
        ok: true,
        output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[schedule] ${schedule.id} failed`, error);
      await finishRun(run.id, { status: 'failed', error: message });
      await recordOutcome(schedule.id, { ok: false, error: message });
      result.failed += 1;
      result.outcomes.push({
        scheduleId: schedule.id,
        title: schedule.title,
        kind: schedule.kind,
        ok: false,
        error: message,
      });
    }
  }

  return result;
}

async function execute(schedule: Schedule): Promise<string> {
  if (schedule.kind === 'reminder') {
    // A reminder is just its text. Storing the run is what makes it deliverable,
    // and no model call is needed — which matters, because most schedules are
    // reminders and they should cost nothing to fire.
    return schedule.payload;
  }

  return runAgentPrompt(schedule);
}

/**
 * Run a scheduled prompt through the agent, with its tools.
 *
 * This is what makes a schedule able to do work rather than only nag: "every
 * weekday at 8, check my mail for anything urgent and put it on my list" is a
 * real agent turn, it just was not typed by a human.
 */
async function runAgentPrompt(schedule: Schedule): Promise<string> {
  const user = await loadUser(schedule.userId);

  const [memories, taskSummaries] = await Promise.all([
    recall({ userId: user.id, query: schedule.payload, limit: 12 }),
    openTaskSummaries(user.id),
  ]);

  const now = new Date();

  const { text, steps } = await generateText({
    model: agentModel(),
    system: [
      buildSystemPrompt({ user, memories, now, openTaskSummaries: taskSummaries }),
      // Told plainly that nobody is waiting: without this the model writes as
      // though mid-conversation and asks clarifying questions nobody will read.
      [
        '# This is a scheduled run',
        '',
        `You are running unattended on a schedule called "${schedule.title}". The user is not present and cannot answer questions.`,
        '',
        '- Do the work and report what you did. Do not ask for clarification; make a reasonable choice and say which you made.',
        '- If there is genuinely nothing to report, say so in one line rather than inventing an update.',
        '- Write for someone reading this later without context. Name the things you looked at.',
        '- Do not send anything outward or delete anything on your own initiative. Creating and updating the tasks and memories is fine.',
      ].join('\n'),
    ].join('\n\n'),
    prompt: schedule.payload,
    tools: buildTools({ user, conversationId: schedule.id }),
    stopWhen: stepCountIs(Math.min(SCHEDULED_STEP_LIMIT, env.maxAgentSteps)),
    providerOptions: agentProviderOptions(),
  });

  const answer = text.trim();
  if (answer.length === 0) {
    // A run that produced no text did something (or nothing) invisibly, and an
    // empty run record is indistinguishable from a broken schedule.
    const toolNames = steps
      .flatMap((step) => step.toolCalls.map((call) => call.toolName))
      .filter((name, index, all) => all.indexOf(name) === index);

    return toolNames.length > 0
      ? `Ran without producing a summary. Tools used: ${toolNames.join(', ')}.`
      : 'Ran and produced no output.';
  }

  return `${answer}\n\n— ${schedule.title}, ${formatInTimezone(now, user.timezone)}`;
}

async function loadUser(userId: string): Promise<User> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw new Error(`The user for this schedule no longer exists (${userId})`);
  return user;
}
