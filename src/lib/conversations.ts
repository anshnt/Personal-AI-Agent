import { generateText } from 'ai';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { UIMessage } from 'ai';

import { TITLE_PROMPT } from '@/lib/ai/prompts';
import { utilityModel, utilityProviderOptions } from '@/lib/ai/provider';
import { db } from '@/lib/db';
import { conversations, messages, type Conversation } from '@/lib/db/schema';

/** Fetch a conversation, or create it under the given id if it does not exist. */
export async function ensureConversation(
  userId: string,
  conversationId: string,
): Promise<Conversation> {
  const existing = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(conversations)
    .values({ id: conversationId, userId })
    .onConflictDoNothing({ target: conversations.id })
    .returning();

  if (created) return created;

  // The id exists but belongs to somebody else, or a concurrent request won the
  // insert. Re-read under the ownership filter so we never hand back another
  // user's conversation.
  const raced = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (!raced[0]) {
    throw new Error('That conversation id is not available');
  }
  return raced[0];
}

export async function listConversations(userId: string, limit = 40): Promise<Conversation[]> {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(Math.min(limit, 200));
}

/** Load a conversation's history in AI SDK `UIMessage` shape. */
export async function loadMessages(conversationId: string): Promise<UIMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    parts: row.parts,
  })) as UIMessage[];
}

/**
 * Persist the post-turn message list.
 *
 * The AI SDK hands back the full updated list rather than a delta, and message
 * ids are stable across turns, so this upserts by id. That keeps the original
 * `createdAt` on rows that already existed, and correctly handles the case
 * where the assistant continued an existing message instead of adding one.
 */
export async function saveMessages(
  conversationId: string,
  updated: UIMessage[],
): Promise<void> {
  if (updated.length === 0) return;

  const rows = updated.map((message, index) => ({
    id: message.id,
    conversationId,
    role: message.role,
    parts: message.parts as unknown[],
    // Ordering must not depend on clock resolution, so index nudges each row.
    createdAt: new Date(Date.now() + index),
  }));

  await db.transaction(async (tx) => {
    await tx
      .insert(messages)
      .values(rows)
      .onConflictDoUpdate({
        target: messages.id,
        set: {
          // Only the parts can change: a streamed message grows as tool calls
          // and text arrive, and the final state is what should be stored.
          parts: sql`excluded.parts`,
        },
      });

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  });
}

export async function deleteConversation(userId: string, conversationId: string): Promise<boolean> {
  const deleted = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id });
  return deleted.length > 0;
}

/**
 * Give an untitled conversation a name, once, in the background.
 *
 * Best-effort by design: a failed title is cosmetic, and the user already has
 * their answer by the time this runs.
 */
export async function maybeTitleConversation(
  conversation: Conversation,
  firstUserMessage: string,
): Promise<void> {
  if (conversation.title) return;
  const seed = firstUserMessage.trim();
  if (seed.length < 4) return;

  try {
    const { text } = await generateText({
      model: utilityModel(),
      system: TITLE_PROMPT,
      prompt: seed.slice(0, 2000),
      providerOptions: utilityProviderOptions(),
    });

    const title = text.trim().replace(/^["']|["']$/g, '').slice(0, 80);
    if (title.length === 0) return;

    // Guard on still-untitled so a concurrent turn cannot overwrite a title.
    await db
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, conversation.id), isNull(conversations.title)));
  } catch (error) {
    console.error('[conversation] titling failed', error);
  }
}

/** Flatten a message's text parts, for extraction and titling. */
export function textOf(message: UIMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}
