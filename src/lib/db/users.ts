import { eq } from 'drizzle-orm';

import { db } from './index';
import { users, type User } from './schema';
import { env } from '@/lib/env';

/**
 * Resolve the acting user, creating the row on first use.
 *
 * A personal agent is single-tenant by default, so the identity comes from
 * configuration rather than a session. The data model is already multi-user, so
 * swapping this for a real auth lookup is a one-function change.
 */
export async function resolveCurrentUser(): Promise<User> {
  const email = env.defaultUserEmail;

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(users)
    .values({
      email,
      name: env.defaultUserName ?? null,
      timezone: env.defaultUserTimezone,
    })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (inserted[0]) return inserted[0];

  // Lost an insert race with a concurrent request; the row exists now.
  const raced = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!raced[0]) {
    throw new Error(`Could not resolve or create the user for ${email}`);
  }
  return raced[0];
}

export async function updateUserProfile(
  userId: string,
  patch: Record<string, unknown>,
): Promise<User> {
  const current = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!current[0]) throw new Error(`Unknown user ${userId}`);

  const merged = { ...current[0].profile, ...patch };
  // An explicit null clears a profile key rather than storing a null value.
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
  }

  const [updated] = await db
    .update(users)
    .set({ profile: merged, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new Error(`Unknown user ${userId}`);
  return updated;
}

export async function setUserIdentity(
  userId: string,
  patch: { name?: string; timezone?: string },
): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (!updated) throw new Error(`Unknown user ${userId}`);
  return updated;
}
