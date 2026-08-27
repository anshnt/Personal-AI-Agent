import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { emailAccounts, emails, type EmailAccount } from '@/lib/db/schema';
import { parseMessage, withSnippet } from './parse';
import { providerFor } from './providers';
import { MailError, type MailProvider } from './types';

export interface SyncResult {
  accountId: string;
  fetched: number;
  stored: number;
  /** Already present, matched on Message-ID. */
  duplicates: number;
  /** Individually unparseable messages. One bad message never fails a sync. */
  failed: number;
  syncedThrough: Date | null;
}

export interface SyncOptions {
  /** Cap on messages pulled in one run. */
  limit?: number;
  /**
   * Ignore the stored cursor and re-read from the beginning.
   *
   * Useful after changing the parser: dedupe makes it safe, since a re-read
   * updates rather than duplicates.
   */
  full?: boolean;
  /** Injected for tests, so the pipeline runs without a mail server. */
  provider?: MailProvider;
}

const DEFAULT_LIMIT = 200;

/**
 * Pull new mail into the database.
 *
 * Incremental by default: the cursor is the newest `receivedAt` already stored,
 * and the provider filters server-side where it can. Dedupe is on Message-ID
 * per account, so overlapping fetch windows are harmless — which is what makes
 * an inclusive, day-granular IMAP `SINCE` the safe choice.
 */
export async function syncAccount(
  account: EmailAccount,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 1000);
  const provider = options.provider ?? providerFor(account);
  const since = options.full ? undefined : (account.syncedThrough ?? undefined);

  const result: SyncResult = {
    accountId: account.id,
    fetched: 0,
    stored: 0,
    duplicates: 0,
    failed: 0,
    syncedThrough: account.syncedThrough,
  };

  try {
    const raw = await provider.fetch({ since, limit });
    result.fetched = raw.length;

    let newest = options.full ? null : account.syncedThrough;

    for (const message of raw) {
      let parsed;
      try {
        parsed = withSnippet(await parseMessage(message));
      } catch (error) {
        // A single malformed message must not abort the run: one bad newsletter
        // would otherwise permanently block the mailbox from syncing.
        result.failed += 1;
        console.error('[email] skipping unparseable message', message.externalId, error);
        continue;
      }

      // The provider's pre-filter uses whatever date it has; the parsed Date
      // header is authoritative, so filter again here.
      if (since && parsed.receivedAt <= since) {
        result.duplicates += 1;
        continue;
      }

      const [row] = await db
        .insert(emails)
        .values({
          userId: account.userId,
          accountId: account.id,
          messageId: parsed.messageId,
          externalId: parsed.externalId,
          threadKey: parsed.threadKey,
          fromAddress: parsed.fromAddress,
          fromName: parsed.fromName,
          toAddresses: parsed.toAddresses,
          ccAddresses: parsed.ccAddresses,
          subject: parsed.subject,
          bodyText: parsed.bodyText,
          snippet: parsed.snippet,
          attachmentNames: parsed.attachmentNames,
          labels: parsed.labels,
          receivedAt: parsed.receivedAt,
        })
        .onConflictDoUpdate({
          target: [emails.accountId, emails.messageId],
          set: {
            // Re-reading a message should refresh what parsing produced, but
            // never invent a new identity for it.
            subject: sql`excluded.subject`,
            bodyText: sql`excluded.body_text`,
            snippet: sql`excluded.snippet`,
            labels: sql`excluded.labels`,
            externalId: sql`excluded.external_id`,
          },
        })
        // `xmax = 0` is true only for a row this statement inserted; on the
        // update branch of an upsert it carries the locking transaction id.
        // Without it, an update is indistinguishable from an insert and the
        // reported counts are wrong on every re-sync.
        .returning({ id: emails.id, inserted: sql<boolean>`xmax = 0` });

      if (row?.inserted) result.stored += 1;
      else if (row) result.duplicates += 1;

      // Only a date we actually got from the message or the server may move the
      // cursor. A fallback date is "now", and a cursor at now would make every
      // older message look already-seen on the next incremental run.
      if (
        parsed.receivedAtSource !== 'fallback' &&
        (newest === null || parsed.receivedAt > newest)
      ) {
        newest = parsed.receivedAt;
      }
    }

    result.syncedThrough = newest;

    await db
      .update(emailAccounts)
      .set({ syncedThrough: newest, lastSyncedAt: new Date(), lastSyncError: null })
      .where(eq(emailAccounts.id, account.id));

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The failure is recorded on the account so the agent can explain why mail
    // looks stale, rather than silently answering from an old snapshot.
    await db
      .update(emailAccounts)
      .set({ lastSyncedAt: new Date(), lastSyncError: message.slice(0, 500) })
      .where(eq(emailAccounts.id, account.id));

    throw error instanceof MailError ? error : new MailError(message);
  } finally {
    await provider.close().catch((error: unknown) => {
      console.error('[email] provider close failed', error);
    });
  }
}

export async function listAccounts(userId: string): Promise<EmailAccount[]> {
  return db.select().from(emailAccounts).where(eq(emailAccounts.userId, userId));
}

export async function getAccount(
  userId: string,
  accountId: string,
): Promise<EmailAccount | undefined> {
  const rows = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)))
    .limit(1);
  return rows[0];
}

export interface UpsertAccountInput {
  userId: string;
  provider: 'imap' | 'local';
  address: string;
  config?: Record<string, unknown>;
}

export async function upsertAccount(input: UpsertAccountInput): Promise<EmailAccount> {
  const address = input.address.trim().toLowerCase();
  if (address.length === 0) throw new MailError('An account needs an address');

  const [account] = await db
    .insert(emailAccounts)
    .values({
      userId: input.userId,
      provider: input.provider,
      address,
      config: input.config ?? {},
    })
    .onConflictDoUpdate({
      target: [emailAccounts.userId, emailAccounts.address],
      set: { provider: input.provider, config: input.config ?? {} },
    })
    .returning();

  if (!account) throw new MailError('Failed to store the mail account');
  return account;
}

/**
 * Create the account described by the environment, if there is one.
 *
 * Mail is configured by the operator, not through the UI, so the account row is
 * derived from `MAIL_PROVIDER` on first use. Returns the accounts that exist
 * afterwards, which is empty when mail is switched off.
 */
export async function ensureConfiguredAccount(userId: string): Promise<EmailAccount[]> {
  const provider = env.mailProvider;
  if (!provider) return listAccounts(userId);

  const address = env.mailAddress ?? env.imapUser ?? env.defaultUserEmail;

  const config: Record<string, unknown> = {};
  if (provider === 'imap') {
    if (env.imapHost) config.host = env.imapHost;
    config.port = env.imapPort;
    if (env.imapUser) config.user = env.imapUser;
  } else if (env.mailLocalDir) {
    config.directory = env.mailLocalDir;
  }

  await upsertAccount({ userId, provider, address, config });
  return listAccounts(userId);
}

/** Sync every configured account, reporting per-account outcomes. */
export async function syncAllAccounts(
  userId: string,
  options: SyncOptions = {},
): Promise<Array<SyncResult | { accountId: string; error: string }>> {
  const accounts = await listAccounts(userId);

  const outcomes: Array<SyncResult | { accountId: string; error: string }> = [];
  for (const account of accounts) {
    try {
      outcomes.push(await syncAccount(account, options));
    } catch (error) {
      // One unreachable server should not stop the others from syncing.
      outcomes.push({
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcomes;
}
