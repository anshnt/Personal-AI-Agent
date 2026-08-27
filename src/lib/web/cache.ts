import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { webCache } from '@/lib/db/schema';

export interface CacheKey {
  userId: string;
  kind: 'search' | 'fetch';
  key: string;
  ttlSeconds: number;
}

/**
 * Read through a cache.
 *
 * Search APIs are metered and page fetches are slow, and an agent working
 * through a multi-step turn re-asks the same question repeatedly. Entries are
 * scoped per user, so one person's browsing is never served to another.
 *
 * A cache write failure never fails the call: the caller already has a real
 * answer, and losing the chance to reuse it is not worth surfacing as an error.
 */
export async function cachedFetch<T>(
  cacheKey: CacheKey,
  produce: () => Promise<T>,
): Promise<T> {
  const normalisedKey = cacheKey.key.trim().slice(0, 2000);

  const existing = await db
    .select({ payload: webCache.payload })
    .from(webCache)
    .where(
      and(
        eq(webCache.userId, cacheKey.userId),
        eq(webCache.kind, cacheKey.kind),
        eq(webCache.cacheKey, normalisedKey),
        sql`${webCache.expiresAt} > now()`,
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0].payload as T;

  const value = await produce();

  try {
    await db
      .insert(webCache)
      .values({
        userId: cacheKey.userId,
        kind: cacheKey.kind,
        cacheKey: normalisedKey,
        payload: value,
        expiresAt: new Date(Date.now() + cacheKey.ttlSeconds * 1000),
      })
      .onConflictDoUpdate({
        target: [webCache.userId, webCache.kind, webCache.cacheKey],
        set: {
          payload: sql`excluded.payload`,
          expiresAt: sql`excluded.expires_at`,
          createdAt: sql`now()`,
        },
      });
  } catch (error) {
    console.error('[web] cache write failed', error);
  }

  return value;
}

/** True when a live entry exists, without producing one. Used for reporting. */
export async function isCached(cacheKey: Omit<CacheKey, 'ttlSeconds'>): Promise<boolean> {
  const rows = await db
    .select({ id: webCache.id })
    .from(webCache)
    .where(
      and(
        eq(webCache.userId, cacheKey.userId),
        eq(webCache.kind, cacheKey.kind),
        eq(webCache.cacheKey, cacheKey.key.trim().slice(0, 2000)),
        sql`${webCache.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Drop expired rows. Safe to call on a schedule or opportunistically. */
export async function purgeExpired(): Promise<number> {
  const deleted = await db
    .delete(webCache)
    .where(lt(webCache.expiresAt, new Date()))
    .returning({ id: webCache.id });
  return deleted.length;
}
