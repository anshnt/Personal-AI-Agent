import { and, arrayOverlaps, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { memories, type Memory, type MemoryKind } from '@/lib/db/schema';

export interface RememberInput {
  userId: string;
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  source?: string;
  expiresAt?: Date | null;
}

export interface RecallOptions {
  userId: string;
  query?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  limit?: number;
}

export interface RecalledMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  importance: number;
  createdAt: Date;
  /** Ranking score in 0..1: text match blended with importance and recency. */
  score: number;
  /**
   * Text-match strength alone, in 0..1, or 0 when the recall had no query.
   *
   * Kept separate from `score` because some decisions must not be swayed by
   * importance — deleting a memory should require that the text actually
   * matched, not that the memory happened to be an important one.
   */
  lexical: number;
}

const DEFAULT_RECALL_LIMIT = 12;
const MAX_RECALL_LIMIT = 50;

/** Memories that are neither expired nor superseded by a correction. */
function liveMemory(userId: string) {
  return and(
    eq(memories.userId, userId),
    isNull(memories.supersededById),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, new Date())),
  );
}

/** Recency decays with a 90-day half-life, so old facts lean on importance. */
const recencyScore = sql<number>`exp(
  -extract(epoch from (now() - ${memories.createdAt})) / (90 * 86400.0)
)`;

function clamp01(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

export function normaliseContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function mergeTags(existing: string[], incoming: string[]): string[] {
  const merged = [...existing, ...incoming].map((tag) => tag.trim().toLowerCase());
  return [...new Set(merged)].filter((tag) => tag.length > 0);
}

/**
 * Turn a natural-language query into an OR-joined `to_tsquery` expression.
 *
 * The obvious choice, `websearch_to_tsquery`, ANDs every term — so a recall for
 * "running marathon training" misses "training for a half marathon" because the
 * stem "run" is absent. Recall wants the opposite: match on any term and let
 * ranking sort out which memory is the best fit.
 *
 * Building the query means `to_tsquery`, which raises on malformed input, so
 * every token is reduced to bare alphanumerics first. After that no operator
 * character can survive and the expression is always well-formed.
 */
export function toTsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 1)
    // Postgres drops stop words itself; the cap is here to stop a pasted wall
    // of text from turning into a hundred-term query.
    .slice(0, 24);

  return [...new Set(terms)].join(' | ');
}

/**
 * Store a memory.
 *
 * The model tends to re-state the same fact across turns, so an exact match on
 * normalised content is reinforced rather than duplicated: importance rises to
 * the higher of the two values and tags are merged.
 */
export async function remember(input: RememberInput): Promise<Memory> {
  const content = normaliseContent(input.content);
  if (content.length === 0) {
    throw new Error('Cannot store an empty memory');
  }

  const kind = input.kind ?? 'fact';
  const importance = clamp01(input.importance ?? 0.5);

  const duplicate = await db
    .select()
    .from(memories)
    .where(
      and(
        liveMemory(input.userId),
        eq(memories.kind, kind),
        sql`lower(${memories.content}) = lower(${content})`,
      ),
    )
    .limit(1);

  if (duplicate[0]) {
    const [reinforced] = await db
      .update(memories)
      .set({
        importance: Math.max(duplicate[0].importance, importance),
        tags: mergeTags(duplicate[0].tags, input.tags ?? []),
        source: input.source ?? duplicate[0].source,
        expiresAt: input.expiresAt === undefined ? duplicate[0].expiresAt : input.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(memories.id, duplicate[0].id))
      .returning();
    if (reinforced) return reinforced;
  }

  const [created] = await db
    .insert(memories)
    .values({
      userId: input.userId,
      kind,
      content,
      tags: mergeTags([], input.tags ?? []),
      importance,
      source: input.source ?? 'manual',
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  if (!created) throw new Error('Failed to store memory');
  return created;
}

/**
 * Retrieve the memories most relevant to a query.
 *
 * With no query this returns the highest-signal memories by importance and
 * recency, which is what the system prompt needs on a cold conversation.
 */
export async function recall(options: RecallOptions): Promise<RecalledMemory[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RECALL_LIMIT, 1), MAX_RECALL_LIMIT);
  // A query of nothing but stop words or punctuation reduces to no terms, in
  // which case the importance-ordered path is the honest answer.
  const tsQuery = toTsQuery(options.query ?? '');

  const filters = [liveMemory(options.userId)];
  if (options.kinds && options.kinds.length > 0) {
    filters.push(inArray(memories.kind, options.kinds));
  }
  if (options.tags && options.tags.length > 0) {
    // Array overlap: keep rows sharing at least one tag.
    filters.push(arrayOverlaps(memories.tags, mergeTags([], options.tags)));
  }

  const baseScore = sql<number>`(0.75 * ${memories.importance} + 0.25 * ${recencyScore})`;

  if (tsQuery.length === 0) {
    const rows = await db
      .select({
        id: memories.id,
        kind: memories.kind,
        content: memories.content,
        tags: memories.tags,
        importance: memories.importance,
        createdAt: memories.createdAt,
        score: baseScore,
      })
      .from(memories)
      .where(and(...filters))
      .orderBy(desc(baseScore))
      .limit(limit);

    await touch(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, score: clamp01(row.score), lexical: 0 }));
  }

  const vector = sql`to_tsvector('english', ${memories.content})`;
  const parsed = sql`to_tsquery('english', ${tsQuery})`;

  // Normalisation flag 32 divides the rank by itself plus one, which bounds it
  // into 0..1 while preserving the ordering that matters: a memory matching
  // three query terms outranks one matching a single term. The observed range
  // is narrow, so it is scaled before being blended.
  const lexical = sql<number>`least(ts_rank_cd(${vector}, ${parsed}, 32) * 3.0, 1.0)`;

  // Text match leads; importance and recency break ties between close matches.
  const rankedScore = sql<number>`(
    0.6 * ${lexical}
    + 0.3 * ${memories.importance}
    + 0.1 * ${recencyScore}
  )`;

  const rows = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      content: memories.content,
      tags: memories.tags,
      importance: memories.importance,
      createdAt: memories.createdAt,
      score: rankedScore,
      lexical,
    })
    .from(memories)
    .where(and(...filters, sql`${vector} @@ ${parsed}`))
    .orderBy(desc(rankedScore))
    .limit(limit);

  await touch(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    score: clamp01(row.score),
    lexical: clamp01(row.lexical),
  }));
}

/** Record that memories were surfaced, so unused ones can be pruned later. */
async function touch(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(memories)
    .set({ lastAccessedAt: new Date(), accessCount: sql`${memories.accessCount} + 1` })
    .where(inArray(memories.id, ids));
}

export async function listMemories(
  userId: string,
  options: { kind?: MemoryKind; limit?: number } = {},
): Promise<Memory[]> {
  const filters = [liveMemory(userId)];
  if (options.kind) filters.push(eq(memories.kind, options.kind));

  return db
    .select()
    .from(memories)
    .where(and(...filters))
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

/**
 * Replace a memory with a corrected version.
 *
 * The old row is kept and pointed at its replacement: "I moved to Berlin"
 * should not silently erase the fact that the user lived somewhere else, and
 * keeping the chain makes wrong corrections recoverable.
 */
export async function reviseMemory(
  userId: string,
  memoryId: string,
  content: string,
): Promise<Memory> {
  const existing = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
    .limit(1);

  if (!existing[0]) throw new Error(`No memory ${memoryId} for this user`);

  const replacement = await remember({
    userId,
    content,
    kind: existing[0].kind,
    tags: existing[0].tags,
    importance: existing[0].importance,
    source: `revision:${memoryId}`,
  });

  if (replacement.id !== memoryId) {
    await db
      .update(memories)
      .set({ supersededById: replacement.id, updatedAt: new Date() })
      .where(eq(memories.id, memoryId));
  }

  return replacement;
}

export async function forgetMemory(userId: string, memoryId: string): Promise<boolean> {
  const deleted = await db
    .delete(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
    .returning({ id: memories.id });
  return deleted.length > 0;
}

/** Text-match strength required before a free-text delete will act. */
const FORGET_CONFIDENCE = 0.5;

/**
 * Free-text delete, for "forget that I like anchovies".
 *
 * Gated on text-match strength alone rather than the blended score: blending in
 * importance would make an important memory easier to delete by accident, which
 * is exactly backwards.
 */
export async function forgetMatching(userId: string, query: string): Promise<Memory[]> {
  const candidates = await recall({ userId, query, limit: 5 });
  const strong = candidates.filter((candidate) => candidate.lexical >= FORGET_CONFIDENCE);
  if (strong.length === 0) return [];

  return db
    .delete(memories)
    .where(
      and(
        eq(memories.userId, userId),
        inArray(
          memories.id,
          strong.map((candidate) => candidate.id),
        ),
      ),
    )
    .returning();
}
