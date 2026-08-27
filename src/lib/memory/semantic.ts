import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { db, sql as client } from '@/lib/db';
import { memories, type MemoryKind } from '@/lib/db/schema';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  embedOne,
  embedTexts,
  embeddingProvider,
  toVectorLiteral,
} from './embeddings';

/**
 * Semantic recall, when the deployment can support it.
 *
 * Two things have to be true: pgvector must be installed on the server, and an
 * embedding provider must be configured. Neither is assumed. The migration adds
 * the column only if the extension exists, so on a plain PostgreSQL the column
 * is simply absent and everything here reports itself unavailable — recall
 * stays lexical and nothing degrades except result quality.
 *
 * That is why the column is queried through raw SQL rather than declared in the
 * Drizzle schema: a declared column that may not exist would make every
 * `select()` on `memories` fail on a database without the extension.
 */

export interface SemanticCapability {
  available: boolean;
  /** Present when unavailable, phrased for a person to act on. */
  reason?: string;
  extensionInstalled: boolean;
  columnPresent: boolean;
  providerName?: string;
  model?: string;
}

let cached: SemanticCapability | undefined;

/**
 * Detect support once per process.
 *
 * Cached because it runs on every recall and the answer cannot change without a
 * migration or a restart.
 */
export async function semanticCapability(): Promise<SemanticCapability> {
  if (cached) return cached;

  const provider = embeddingProvider();

  let extensionInstalled = false;
  let columnPresent = false;

  try {
    const rows = await client<Array<{ has_extension: boolean; has_column: boolean }>>`
      select
        exists (select 1 from pg_extension where extname = 'vector') as has_extension,
        exists (
          select 1 from information_schema.columns
          where table_name = 'memories' and column_name = 'embedding'
        ) as has_column
    `;
    extensionInstalled = rows[0]?.has_extension ?? false;
    columnPresent = rows[0]?.has_column ?? false;
  } catch (error) {
    // An unreachable database is not this function's problem to report; recall
    // will fail loudly on its own. Semantic support is simply unknown, so off.
    console.error('[memory] could not detect semantic support', error);
  }

  const reasons: string[] = [];
  if (!extensionInstalled) {
    reasons.push('the pgvector extension is not installed on this database');
  } else if (!columnPresent) {
    reasons.push('the embedding column is missing; re-run the migrations');
  }
  if (!provider) {
    reasons.push('no embedding provider is configured (set VOYAGE_API_KEY or OPENAI_API_KEY)');
  }

  cached = {
    available: extensionInstalled && columnPresent && provider !== undefined,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    extensionInstalled,
    columnPresent,
    providerName: provider?.name,
    model: provider?.model,
  };

  return cached;
}

/** Clear the cached detection. For tests that change the database or config. */
export function resetSemanticCapability(): void {
  cached = undefined;
}

/* -------------------------------------------------------------------------- */
/* Writing vectors                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Embed and store vectors for memories that do not have one.
 *
 * Best-effort by design: a memory without an embedding is still recalled
 * lexically, so a provider outage degrades quality rather than losing data. It
 * is also idempotent, which is what makes it safe to call on a schedule or after
 * a provider change.
 */
export async function backfillEmbeddings(
  userId: string,
  limit = 100,
): Promise<{ embedded: number; skipped: number; reason?: string }> {
  const capability = await semanticCapability();
  if (!capability.available) {
    return { embedded: 0, skipped: 0, reason: capability.reason };
  }

  const model = capability.model ?? 'unknown';

  // Rows with no vector, or one produced by a different model. A model change
  // makes existing vectors incomparable, so they are replaced rather than mixed.
  const pending = await client<Array<{ id: string; content: string }>>`
    select id, content
    from memories
    where user_id = ${userId}
      and superseded_by_id is null
      and (embedding is null or embedding_model is distinct from ${model})
    order by importance desc, created_at desc
    limit ${Math.min(Math.max(limit, 1), 500)}
  `;

  if (pending.length === 0) return { embedded: 0, skipped: 0 };

  let vectors: number[][] | undefined;
  try {
    vectors = await embedTexts(pending.map((row) => row.content));
  } catch (error) {
    const reason = error instanceof EmbeddingError ? error.message : String(error);
    console.error('[memory] embedding backfill failed', error);
    return { embedded: 0, skipped: pending.length, reason };
  }

  if (!vectors) return { embedded: 0, skipped: pending.length, reason: 'no embedding provider' };

  let embedded = 0;
  for (const [index, row] of pending.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    try {
      await client`
        update memories
        set embedding = ${toVectorLiteral(vector)}::vector,
            embedding_model = ${model}
        where id = ${row.id}::uuid
      `;
      embedded += 1;
    } catch (error) {
      console.error('[memory] could not store an embedding', row.id, error);
    }
  }

  return { embedded, skipped: pending.length - embedded };
}

/** Store one vector, for a memory that was just written. */
export async function embedMemory(memoryId: string, content: string): Promise<boolean> {
  const capability = await semanticCapability();
  if (!capability.available) return false;

  try {
    const vector = await embedOne(content);
    if (!vector) return false;

    await client`
      update memories
      set embedding = ${toVectorLiteral(vector)}::vector,
          embedding_model = ${capability.model ?? 'unknown'}
      where id = ${memoryId}::uuid
    `;
    return true;
  } catch (error) {
    // The memory is already stored; only its vector is missing, and lexical
    // recall still finds it.
    console.error('[memory] could not embed a new memory', memoryId, error);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Semantic search                                                            */
/* -------------------------------------------------------------------------- */

export interface SemanticHit {
  id: string;
  /** Cosine similarity in 0..1, where 1 is identical. */
  similarity: number;
}

/**
 * Find the memories closest in meaning to a query.
 *
 * Returns an empty list rather than throwing when semantic recall is
 * unavailable, so callers do not have to branch on capability before asking.
 */
export async function semanticSearch(options: {
  userId: string;
  query: string;
  kinds?: MemoryKind[];
  limit?: number;
}): Promise<SemanticHit[]> {
  const capability = await semanticCapability();
  if (!capability.available) return [];

  const query = options.query.trim();
  if (query.length === 0) return [];

  let vector: number[] | undefined;
  try {
    vector = await embedOne(query);
  } catch (error) {
    console.error('[memory] could not embed the query', error);
    return [];
  }
  if (!vector) return [];

  const literal = toVectorLiteral(vector);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const model = capability.model ?? 'unknown';

  try {
    // `<=>` is pgvector's cosine distance, in 0..2. Only rows embedded with the
    // current model are compared, because vectors from different models are not
    // in the same space.
    const rows = await client<Array<{ id: string; distance: number }>>`
      select id, (embedding <=> ${literal}::vector) as distance
      from memories
      where user_id = ${options.userId}::uuid
        and superseded_by_id is null
        and (expires_at is null or expires_at > now())
        and embedding is not null
        and embedding_model = ${model}
      order by embedding <=> ${literal}::vector
      limit ${limit}
    `;

    return rows.map((row) => ({
      id: row.id,
      // Cosine distance to similarity. Clamped because floating point can put
      // an identical vector a hair outside the range.
      similarity: Math.min(1, Math.max(0, 1 - Number(row.distance) / 2)),
    }));
  } catch (error) {
    console.error('[memory] semantic search failed', error);
    return [];
  }
}

export interface EmbeddingCoverage {
  /** Live memories, whether indexed or not. */
  total: number;
  /** Usable by semantic recall right now, meaning indexed by the current model. */
  embedded: number;
  /**
   * Carrying any vector at all, including one from a previous model.
   *
   * Reported separately because the two numbers differing is a specific,
   * fixable state — the provider changed and the old vectors are no longer
   * comparable — and it is invisible if only usable coverage is counted.
   */
  withAnyEmbedding: number;
}

/**
 * How many memories carry a usable vector.
 *
 * Worth reporting because semantic recall over a fraction of someone's memories
 * behaves worse than none: it looks like it worked.
 */
export async function embeddingCoverage(userId: string): Promise<EmbeddingCoverage> {
  const capability = await semanticCapability();

  const live = and(
    eq(memories.userId, userId),
    isNull(memories.supersededById),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, new Date())),
  );

  const totals = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(memories)
    .where(live);
  const total = totals[0]?.total ?? 0;

  if (!capability.columnPresent) return { total, embedded: 0, withAnyEmbedding: 0 };

  const rows = await client<Array<{ usable: number; any_vector: number }>>`
    select
      count(*) filter (where embedding_model = ${capability.model ?? ''})::int as usable,
      count(*)::int as any_vector
    from memories
    where user_id = ${userId}::uuid
      and superseded_by_id is null
      and (expires_at is null or expires_at > now())
      and embedding is not null
  `;

  return {
    total,
    // With no provider configured there is no current model, so nothing is
    // usable regardless of what is stored.
    embedded: capability.model ? (rows[0]?.usable ?? 0) : 0,
    withAnyEmbedding: rows[0]?.any_vector ?? 0,
  };
}

export { EMBEDDING_DIMENSIONS };
