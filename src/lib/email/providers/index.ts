import { env } from '@/lib/env';
import type { EmailAccount } from '@/lib/db/schema';
import { MailError, type MailProvider } from '../types';
import { ImapMailProvider, type ImapSettings } from './imap';
import { LocalMailProvider } from './local';

/**
 * Build the provider for a stored account.
 *
 * Credentials come from the environment, never from the database row: the row
 * holds host, port, and mailbox, so a database dump does not carry a password
 * that reads someone's mail.
 */
export function providerFor(account: EmailAccount): MailProvider {
  switch (account.provider) {
    case 'imap': {
      const settings = imapSettingsFrom(account);
      return new ImapMailProvider(settings);
    }
    case 'local': {
      const directory = readString(account.config, 'directory') ?? env.mailLocalDir;
      if (!directory) {
        throw new MailError(
          'This account has no directory configured and MAIL_LOCAL_DIR is not set.',
        );
      }
      return new LocalMailProvider(directory);
    }
    default: {
      // Exhaustive over the enum; this only fires if a variant is added without
      // a provider to go with it.
      const unreachable: never = account.provider;
      throw new MailError(`No provider for ${String(unreachable)}`);
    }
  }
}

function imapSettingsFrom(account: EmailAccount): ImapSettings {
  const password = env.imapPassword;
  if (!password) {
    throw new MailError(
      'IMAP_PASSWORD is not set. For Gmail and Outlook this must be an app password, not the account password.',
    );
  }

  const host = readString(account.config, 'host') ?? env.imapHost;
  if (!host) {
    throw new MailError('No IMAP host configured. Set IMAP_HOST.');
  }

  const port = readNumber(account.config, 'port') ?? env.imapPort;
  const secure = readBoolean(account.config, 'secure') ?? port === 993;

  return {
    host,
    port,
    secure,
    user: readString(account.config, 'user') ?? env.imapUser ?? account.address,
    password,
    mailbox: readString(account.config, 'mailbox') ?? 'INBOX',
  };
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key];
  return typeof value === 'boolean' ? value : undefined;
}

export { ImapMailProvider, LocalMailProvider };
export type { ImapSettings };
