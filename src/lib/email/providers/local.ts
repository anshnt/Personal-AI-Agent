import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isWithin } from '@/lib/documents/local-files';
import { MailError, type FetchOptions, type MailProvider, type RawMessage } from '../types';

/**
 * Read mail from a directory of `.eml` files.
 *
 * This is what an exported mailbox looks like, and it is what most mail clients
 * produce when you drag a message to the desktop. It also means the whole email
 * pipeline can be exercised without credentials or a network — which is the
 * difference between a tested sync path and a hoped-for one.
 */
export class LocalMailProvider implements MailProvider {
  readonly kind = 'local' as const;

  constructor(private readonly directory: string) {}

  get describe(): string {
    return `local directory ${this.directory}`;
  }

  async fetch(options: FetchOptions): Promise<RawMessage[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      throw new MailError(
        `Could not read the mail directory ${this.directory}. Check MAIL_LOCAL_DIR.`,
      );
    }

    const candidates = entries
      .filter((name) => name.toLowerCase().endsWith('.eml'))
      .filter((name) => !name.startsWith('.'))
      .sort();

    const messages: RawMessage[] = [];

    for (const name of candidates) {
      if (messages.length >= options.limit) break;

      const path = join(this.directory, name);
      // A filename from a directory listing cannot contain a separator, but the
      // check costs nothing and keeps the guarantee local to this file.
      if (!isWithin(this.directory, path)) continue;

      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;

      // Filesystem mtime is the only date available before parsing, so it is
      // used for the cheap pre-filter. The parsed Date header is authoritative
      // and the sync pipeline filters again on it.
      if (options.since && info.mtime <= options.since) continue;

      messages.push({
        externalId: name,
        raw: new Uint8Array(await readFile(path)),
        receivedAt: info.mtime,
      });
    }

    return messages;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
