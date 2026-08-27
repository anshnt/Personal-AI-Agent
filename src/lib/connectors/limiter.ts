import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { connectorUsage } from '@/lib/db/schema';

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  /** When the current window ends, so a refusal can say when to retry. */
  resetAt: Date;
}

/**
 * Per-user, per-connector rate limiting, persisted.
 *
 * In the database rather than in memory for two reasons: an agent loop can
 * retry a failing call several times within one turn, and a serverless
 * deployment has no shared memory to count in — an in-process counter would
 * reset on every cold start, which is no limit at all.
 *
 * Fixed windows rather than a sliding log. A sliding window is more accurate at
 * the boundary, but it needs a row per call; the point here is to stop a runaway
 * loop and stay inside somebody's free tier, and a fixed window does that with
 * one row per connector per window.
 */
export async function consume(
  userId: string,
  connector: string,
  limit: { calls: number; windowSeconds: number },
): Promise<RateVerdict> {
  // Windows are aligned to the epoch, so every instance computes the same
  // boundary without coordinating.
  const windowMs = limit.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);

  // A single statement does the increment, so two concurrent calls cannot both
  // read the same count and both decide they are under the limit.
  const [row] = await db
    .insert(connectorUsage)
    .values({ userId, connector, windowStart, calls: 1 })
    .onConflictDoUpdate({
      target: [connectorUsage.userId, connectorUsage.connector, connectorUsage.windowStart],
      set: { calls: sql`${connectorUsage.calls} + 1` },
    })
    .returning({ calls: connectorUsage.calls });

  const used = row?.calls ?? 1;

  return {
    allowed: used <= limit.calls,
    remaining: Math.max(0, limit.calls - used),
    resetAt,
  };
}

/** Give back a consumed slot, for a call that never actually went out. */
export async function refund(
  userId: string,
  connector: string,
  windowSeconds: number,
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

  await db
    .update(connectorUsage)
    .set({ calls: sql`greatest(0, ${connectorUsage.calls} - 1)` })
    .where(
      and(
        eq(connectorUsage.userId, userId),
        eq(connectorUsage.connector, connector),
        eq(connectorUsage.windowStart, windowStart),
      ),
    );
}

/** Drop windows that have passed. Safe to call on a schedule. */
export async function purgeOldWindows(olderThanHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000);
  // `lt` rather than a raw sql template: a JS Date interpolated into a template
  // is bound without the column's type mapping, and postgres-js then rejects it.
  const deleted = await db
    .delete(connectorUsage)
    .where(lt(connectorUsage.windowStart, cutoff))
    .returning({ userId: connectorUsage.userId });
  return deleted.length;
}
