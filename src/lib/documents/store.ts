import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  documentChunks,
  documents,
  type Document,
  type DocumentChunk,
} from '@/lib/db/schema';
import { toTsQuery } from '@/lib/memory/store';
import { chunkText } from './chunk';
import { parseDocument, type DocumentKind } from './parse';

export interface IngestInput {
  userId: string;
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
  source?: string;
}

export interface IngestResult {
  document: Document;
  chunks: number;
  /** True when this file was already stored and the row was replaced. */
  replaced: boolean;
}

/**
 * Parse, store, and index a file.
 *
 * Re-ingesting the same bytes replaces the existing document rather than
 * creating a second copy: syncing a folder or re-uploading an attachment should
 * be idempotent, not a way to fill the database with duplicates.
 */
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('A document needs a name');

  const parsed = await parseDocument(name, input.bytes, input.mimeType);
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');

  const chunks = chunkText(parsed.text);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.userId, input.userId), eq(documents.contentHash, contentHash)))
      .limit(1);

    const values = {
      userId: input.userId,
      name,
      kind: parsed.kind,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.bytes.byteLength,
      contentHash,
      content: parsed.text,
      metadata: parsed.metadata,
      source: input.source ?? 'upload',
      updatedAt: new Date(),
    };

    const [document] = await tx
      .insert(documents)
      .values(values)
      .onConflictDoUpdate({
        target: [documents.userId, documents.contentHash],
        set: {
          name: values.name,
          kind: values.kind,
          content: values.content,
          metadata: values.metadata,
          source: values.source,
          updatedAt: values.updatedAt,
        },
      })
      .returning();

    if (!document) throw new Error('Failed to store the document');

    // Chunks are derived data: rebuild them wholesale rather than diffing.
    await tx.delete(documentChunks).where(eq(documentChunks.documentId, document.id));

    if (chunks.length > 0) {
      await tx.insert(documentChunks).values(
        chunks.map((chunk) => ({
          documentId: document.id,
          userId: input.userId,
          ordinal: chunk.ordinal,
          content: chunk.content,
          charOffset: chunk.charOffset,
        })),
      );
    }

    return { document, chunks: chunks.length, replaced: existing.length > 0 };
  });
}

export interface DocumentSearchHit {
  documentId: string;
  documentName: string;
  kind: DocumentKind;
  ordinal: number;
  charOffset: number;
  excerpt: string;
  /** Text-match strength in 0..1. */
  relevance: number;
}

/**
 * Search across a user's documents, returning passages rather than whole files.
 *
 * `ts_headline` supplies the excerpt, so the returned text is centred on the
 * match instead of being the first N characters of a chunk that happened to
 * mention the term at the end.
 */
export async function searchDocuments(options: {
  userId: string;
  query: string;
  documentIds?: string[];
  limit?: number;
}): Promise<DocumentSearchHit[]> {
  const tsQuery = toTsQuery(options.query);
  if (tsQuery.length === 0) return [];

  const limit = Math.min(Math.max(options.limit ?? 8, 1), 30);

  const vector = sql`to_tsvector('english', ${documentChunks.content})`;
  const parsed = sql`to_tsquery('english', ${tsQuery})`;
  const relevance = sql<number>`least(ts_rank_cd(${vector}, ${parsed}, 32) * 3.0, 1.0)`;

  const filters = [eq(documentChunks.userId, options.userId), sql`${vector} @@ ${parsed}`];
  if (options.documentIds && options.documentIds.length > 0) {
    filters.push(inArray(documentChunks.documentId, options.documentIds));
  }

  const rows = await db
    .select({
      documentId: documentChunks.documentId,
      documentName: documents.name,
      kind: documents.kind,
      ordinal: documentChunks.ordinal,
      charOffset: documentChunks.charOffset,
      excerpt: sql<string>`ts_headline(
        'english',
        ${documentChunks.content},
        ${parsed},
        'MaxFragments=2, MaxWords=40, MinWords=15, StartSel=<<, StopSel=>>'
      )`,
      relevance,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(and(...filters))
    .orderBy(desc(relevance))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    relevance: Math.min(1, Math.max(0, Number(row.relevance))),
  }));
}

export async function listDocuments(userId: string, limit = 100): Promise<Document[]> {
  return db
    .select()
    .from(documents)
    .where(eq(documents.userId, userId))
    .orderBy(desc(documents.createdAt))
    .limit(Math.min(limit, 500));
}

export async function getDocument(userId: string, documentId: string): Promise<Document | undefined> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
    .limit(1);
  return rows[0];
}

/** Find a document by a fragment of its name, for "what did the invoice say". */
export async function findDocumentsByName(userId: string, query: string): Promise<Document[]> {
  const term = query.trim();
  if (term.length === 0) return [];

  return db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), sql`${documents.name} ilike ${`%${term}%`}`))
    .orderBy(desc(documents.createdAt))
    .limit(10);
}

export async function getChunks(
  userId: string,
  documentId: string,
  fromOrdinal: number,
  count: number,
): Promise<DocumentChunk[]> {
  return db
    .select()
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.userId, userId),
        eq(documentChunks.documentId, documentId),
        sql`${documentChunks.ordinal} >= ${fromOrdinal}`,
        sql`${documentChunks.ordinal} < ${fromOrdinal + count}`,
      ),
    )
    .orderBy(documentChunks.ordinal);
}

export async function countChunks(userId: string, documentId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(documentChunks)
    .where(and(eq(documentChunks.userId, userId), eq(documentChunks.documentId, documentId)));
  return rows[0]?.total ?? 0;
}

export async function deleteDocument(userId: string, documentId: string): Promise<boolean> {
  const deleted = await db
    .delete(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
    .returning({ id: documents.id });
  return deleted.length > 0;
}
