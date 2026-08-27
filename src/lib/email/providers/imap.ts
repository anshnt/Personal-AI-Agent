import { ImapFlow } from 'imapflow';

import { MailError, type FetchOptions, type MailProvider, type RawMessage } from '../types';

export interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** Mailbox to read. `INBOX` unless the user wants something else. */
  mailbox: string;
}

/**
 * Read mail over IMAP.
 *
 * IMAP rather than a provider-specific API because it covers Gmail, Outlook,
 * Fastmail, and self-hosted servers through one implementation — with an app
 * password rather than an OAuth consent flow, which matters for something one
 * person runs for themselves.
 *
 * This class is deliberately thin: it fetches raw RFC 5322 bytes and nothing
 * else. Every decision about what a message *means* happens in the shared
 * parse and sync pipeline, which is testable without a server.
 */
export class ImapMailProvider implements MailProvider {
  readonly kind = 'imap' as const;

  private client: ImapFlow | undefined;

  constructor(private readonly settings: ImapSettings) {}

  get describe(): string {
    return `${this.settings.user} at ${this.settings.host}:${this.settings.port} (${this.settings.mailbox})`;
  }

  async fetch(options: FetchOptions): Promise<RawMessage[]> {
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: { user: this.settings.user, pass: this.settings.password },
      // The default logger writes every IMAP command to stdout, which for a
      // mailbox means logging message metadata on every sync.
      logger: false,
    });

    this.client = client;

    try {
      await client.connect();
    } catch (error) {
      throw new MailError(
        `Could not connect to ${this.settings.host}: ${error instanceof Error ? error.message : error}`,
      );
    }

    // A read-only open cannot mark messages as seen. Reading your mail through
    // the agent should not change what your mail client shows as unread.
    const lock = await client.getMailboxLock(this.settings.mailbox, { readOnly: true });

    try {
      // IMAP SINCE has day granularity and is inclusive, so the day itself is
      // re-fetched on every sync. That is correct rather than wasteful: dedupe
      // happens on Message-ID, and the alternative risks dropping a message
      // that arrived later on the cursor's own day.
      const criteria = options.since ? { since: options.since } : { all: true };
      const uids = await client.search(criteria, { uid: true });

      if (uids === false || uids.length === 0) return [];

      // Newest first, then capped: a first sync of a decade-old mailbox should
      // bring back recent mail, not the oldest thousand messages.
      const selected = uids.slice(-options.limit).reverse();

      const messages: RawMessage[] = [];
      for await (const message of client.fetch(
        selected,
        { uid: true, source: true, internalDate: true, labels: true },
        { uid: true },
      )) {
        if (!message.source) continue;
        messages.push({
          externalId: String(message.uid),
          raw: new Uint8Array(message.source),
          // imapflow types internalDate loosely; normalise to a Date so the
          // shared pipeline never has to guess what it received.
          receivedAt: toDate(message.internalDate),
          labels: message.labels ? [...message.labels] : undefined,
        });
      }

      return messages;
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // A failed logout should never mask the real error from a failed fetch,
      // and the socket is torn down either way.
    } finally {
      this.client = undefined;
    }
  }
}

function toDate(value: string | Date | undefined): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
