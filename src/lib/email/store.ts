import { and, arrayOverlaps, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { emailAccounts, emails, type Email } from '@/lib/db/schema';
import { toTsQuery } from '@/lib/memory/store';

export interface EmailSearchOptions {
  userId: string;
  query?: string;
  /** Substring match on sender address or display name. */
  from?: string;
  labels?: string[];
  since?: Date;
  until?: Date;
  hasAttachments?: boolean;
  limit?: number;
}

export interface EmailHit {
  id: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  receivedAt: Date;
  labels: string[];
  attachmentNames: string[];
  threadKey: string | null;
  /** Text-match strength in 0..1, or 0 for a filter-only search. */
  relevance: number;
}

/**
 * The searchable document for a message.
 *
 * Weighted so subject beats sender beats body: a search for a subject line
 * should return that message, not one that mentions the same words in passing.
 * This expression is duplicated in the schema's index — they must stay in step
 * or the index stops being used.
 */
const searchVector = sql`(
  setweight(to_tsvector('english', coalesce(${emails.subject}, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(${emails.fromName}, '') || ' ' || ${emails.fromAddress}), 'B') ||
  setweight(to_tsvector('english', coalesce(${emails.bodyText}, '')), 'C')
)`;

/**
 * Search stored mail.
 *
 * Filters work without a query, so "what did Priya send me last week" is one
 * call rather than a text search that happens to match a name.
 */
export async function searchEmail(options: EmailSearchOptions): Promise<EmailHit[]> {
  const limit = Math.min(Math.max(options.limit ?? 15, 1), 100);
  const tsQuery = toTsQuery(options.query ?? '');

  const filters = [eq(emails.userId, options.userId)];

  if (options.from) {
    const term = `%${options.from.trim().toLowerCase()}%`;
    filters.push(
      sql`(${emails.fromAddress} ilike ${term} or coalesce(${emails.fromName}, '') ilike ${term})`,
    );
  }
  if (options.labels && options.labels.length > 0) {
    filters.push(arrayOverlaps(emails.labels, options.labels));
  }
  if (options.since) filters.push(gte(emails.receivedAt, options.since));
  if (options.until) filters.push(lte(emails.receivedAt, options.until));
  if (options.hasAttachments === true) {
    filters.push(sql`cardinality(${emails.attachmentNames}) > 0`);
  } else if (options.hasAttachments === false) {
    filters.push(sql`cardinality(${emails.attachmentNames}) = 0`);
  }

  const columns = {
    id: emails.id,
    fromAddress: emails.fromAddress,
    fromName: emails.fromName,
    subject: emails.subject,
    snippet: emails.snippet,
    receivedAt: emails.receivedAt,
    labels: emails.labels,
    attachmentNames: emails.attachmentNames,
    threadKey: emails.threadKey,
  };

  if (tsQuery.length === 0) {
    // Filter-only search: newest first is the only sensible order.
    const rows = await db
      .select(columns)
      .from(emails)
      .where(and(...filters))
      .orderBy(desc(emails.receivedAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, relevance: 0 }));
  }

  const parsed = sql`to_tsquery('english', ${tsQuery})`;
  const relevance = sql<number>`least(ts_rank_cd(${searchVector}, ${parsed}, 32) * 3.0, 1.0)`;

  const rows = await db
    .select({ ...columns, relevance })
    .from(emails)
    .where(and(...filters, sql`${searchVector} @@ ${parsed}`))
    .orderBy(desc(relevance), desc(emails.receivedAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    relevance: Math.min(1, Math.max(0, Number(row.relevance))),
  }));
}

export async function getEmail(userId: string, emailId: string): Promise<Email | undefined> {
  const rows = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, emailId), eq(emails.userId, userId)))
    .limit(1);
  return rows[0];
}

/** Every message in the same reply chain, oldest first. */
export async function getThread(userId: string, threadKey: string): Promise<Email[]> {
  return db
    .select()
    .from(emails)
    .where(and(eq(emails.userId, userId), eq(emails.threadKey, threadKey)))
    .orderBy(emails.receivedAt)
    .limit(50);
}

export async function recentEmail(userId: string, limit = 20): Promise<EmailHit[]> {
  return searchEmail({ userId, limit });
}

export interface MailboxStatus {
  address: string;
  provider: string;
  messages: number;
  newestAt: Date | null;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}

/**
 * Per-account counts and freshness.
 *
 * The agent needs this to answer honestly: "nothing from Priya" means something
 * different when the last sync failed three days ago.
 */
export async function mailboxStatus(userId: string): Promise<MailboxStatus[]> {
  const rows = await db
    .select({
      address: emailAccounts.address,
      provider: emailAccounts.provider,
      lastSyncedAt: emailAccounts.lastSyncedAt,
      lastSyncError: emailAccounts.lastSyncError,
      messages: sql<number>`count(${emails.id})::int`,
      newestAt: sql<Date | null>`max(${emails.receivedAt})`,
    })
    .from(emailAccounts)
    .leftJoin(emails, eq(emails.accountId, emailAccounts.id))
    .where(eq(emailAccounts.userId, userId))
    .groupBy(
      emailAccounts.id,
      emailAccounts.address,
      emailAccounts.provider,
      emailAccounts.lastSyncedAt,
      emailAccounts.lastSyncError,
    );

  return rows.map((row) => ({
    ...row,
    newestAt: row.newestAt ? new Date(row.newestAt) : null,
  }));
}
