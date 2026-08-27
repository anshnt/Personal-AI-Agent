import { db } from '@/lib/db';
import { toolExecutions } from '@/lib/db/schema';
import type { User } from '@/lib/db/schema';

/**
 * Everything a tool needs to know about who it is acting for.
 *
 * Tools receive this by closure rather than as a model-visible argument, so the
 * model can never claim to be a different user or write into another user's
 * data by manipulating tool input.
 */
export interface AgentContext {
  user: User;
  conversationId: string;
}

/** Structured tool result. Tools never throw at the model; they return this. */
export type ToolResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Wrap a tool body with audit logging and error containment.
 *
 * A thrown tool aborts the whole agent turn, which is the wrong failure mode:
 * the model can usually recover from "that lookup failed" if it is told so.
 * Every execution is recorded either way.
 */
export function instrument<Input, Output extends object>(
  toolName: string,
  context: AgentContext,
  body: (input: Input) => Promise<ToolResult<Output>>,
): (input: Input) => Promise<ToolResult<Output>> {
  return async (input: Input) => {
    const startedAt = Date.now();
    let result: ToolResult<Output>;

    try {
      result = await body(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool:${toolName}] failed`, error);
      result = failure(message);
    }

    void recordExecution({
      toolName,
      context,
      input,
      result,
      durationMs: Date.now() - startedAt,
    });

    return result;
  };
}

async function recordExecution(args: {
  toolName: string;
  context: AgentContext;
  input: unknown;
  result: { ok: boolean; error?: string };
  durationMs: number;
}): Promise<void> {
  try {
    await db.insert(toolExecutions).values({
      userId: args.context.user.id,
      conversationId: args.context.conversationId,
      toolName: args.toolName,
      input: args.input ?? null,
      // The audit row records the shape of what happened, not full payloads:
      // tool outputs can be large and are already in the message history.
      output: summariseForAudit(args.result),
      ok: args.result.ok,
      errorMessage: args.result.ok ? null : (args.result.error ?? 'unknown error'),
      durationMs: args.durationMs,
    });
  } catch (error) {
    console.error('[tool] could not write audit row', error);
  }
}

const AUDIT_OUTPUT_LIMIT = 4000;

function summariseForAudit(result: unknown): unknown {
  try {
    const serialised = JSON.stringify(result);
    if (serialised.length <= AUDIT_OUTPUT_LIMIT) return result;
    return { truncated: true, preview: serialised.slice(0, AUDIT_OUTPUT_LIMIT) };
  } catch {
    return { unserialisable: true };
  }
}
