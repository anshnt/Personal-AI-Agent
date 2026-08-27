import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseMessage, snippetOf, withSnippet } from './parse';
import { MailError, type RawMessage } from './types';

const mailDir = join(process.cwd(), 'scripts', 'fixtures', 'mail');
const rawOf = async (name: string): Promise<RawMessage> => ({
  externalId: name,
  raw: new Uint8Array(await readFile(join(mailDir, name))),
});
const rawFrom = (text: string): RawMessage => ({
  externalId: 'inline',
  raw: new TextEncoder().encode(text.replace(/\n/g, '\r\n')),
});

describe('parseMessage', () => {
  it('normalises the message id', async () => {
    const parsed = await parseMessage(await rawOf('01-invoice.eml'));
    // Brackets stripped so the value is stable regardless of the provider.
    expect(parsed.messageId).toBe('invoice-4471@vendor.example');
  });

  it('lowercases the sender address but keeps the display name', async () => {
    const parsed = await parseMessage(await rawOf('01-invoice.eml'));
    expect(parsed.fromAddress).toBe('billing@vendor.example');
    expect(parsed.fromName).toBe('Billing Team');
  });

  it('prefers the Date header over the provider timestamp', async () => {
    const parsed = await parseMessage({
      ...(await rawOf('01-invoice.eml')),
      receivedAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(parsed.receivedAt.toISOString()).toBe('2026-08-17T09:14:00.000Z');
    expect(parsed.receivedAtSource).toBe('header');
  });

  it('falls back to the provider timestamp when there is no Date header', async () => {
    const provided = new Date('2026-05-05T05:05:00Z');
    const parsed = await parseMessage({
      ...rawFrom('From: a@b.example\nSubject: no date\n\nbody\n'),
      receivedAt: provided,
    });
    expect(parsed.receivedAt.toISOString()).toBe(provided.toISOString());
    expect(parsed.receivedAtSource).toBe('provider');
  });

  it('marks an invented date as a fallback', async () => {
    // This is what stops the sync cursor being dragged to "now", which would
    // make every legitimately older message look already-seen.
    const parsed = await parseMessage(rawFrom('From: a@b.example\nSubject: no date\n\nbody\n'));
    expect(parsed.receivedAtSource).toBe('fallback');
  });

  it('takes the thread root from References, which is oldest-first', async () => {
    const parsed = await parseMessage(await rawOf('02-invoice-reply.eml'));
    expect(parsed.threadKey).toBe('invoice-4471@vendor.example');
  });

  it('treats a thread-starting message as its own root', async () => {
    const parsed = await parseMessage(await rawOf('01-invoice.eml'));
    expect(parsed.threadKey).toBe('invoice-4471@vendor.example');
  });

  it('falls back to In-Reply-To when there is no References header', async () => {
    const parsed = await parseMessage(
      rawFrom('From: a@b.example\nIn-Reply-To: <root@x>\nSubject: re\nDate: Mon, 17 Aug 2026 09:00:00 +0000\n\nbody\n'),
    );
    expect(parsed.threadKey).toBe('root@x');
  });

  it('falls back to the HTML part for HTML-only mail', async () => {
    // Extremely common, and the difference between reading most of a mailbox
    // and reading a third of it.
    const parsed = await parseMessage(await rawOf('03-newsletter.eml'));
    expect(parsed.bodyText).toContain('Async traits are stable');
    expect(parsed.bodyText).not.toContain('track()');
    expect(parsed.bodyText).not.toContain('color:#000');
  });

  it('unquotes a quoted display name', async () => {
    const parsed = await parseMessage(await rawOf('03-newsletter.eml'));
    expect(parsed.fromName).toBe('Weekly Rust');
  });

  it('reads the text part of a multipart message and lists attachments', async () => {
    const parsed = await parseMessage(await rawOf('04-review.eml'));
    expect(parsed.bodyText).toContain('Room 4');
    expect(parsed.attachmentNames).toContain('deck.pdf');
  });

  it('parses and lowercases cc addresses', async () => {
    const parsed = await parseMessage(await rawOf('04-review.eml'));
    expect(parsed.ccAddresses).toHaveLength(2);
    expect(parsed.ccAddresses.every((address) => address === address.toLowerCase())).toBe(true);
  });

  it('hashes the content when there is no Message-ID', async () => {
    const parsed = await parseMessage(await rawOf('06-no-message-id.eml'));
    expect(parsed.messageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('decodes an RFC 2047 encoded subject', async () => {
    const parsed = await parseMessage(await rawOf('06-no-message-id.eml'));
    expect(parsed.subject).toBe('CPU over 90% on db-01');
  });

  it('rejects bytes with no recognisable headers', async () => {
    // mailparser is lenient: handed arbitrary bytes it returns a message-shaped
    // object with every field empty, dated now. Stored, that is a junk row
    // whose received time is the present, which drags the sync cursor forward
    // and hides real mail behind it.
    await expect(parseMessage(await rawOf('07-broken.eml'))).rejects.toThrow(MailError);
  });

  it('accepts a sparse but real message', async () => {
    // A From header alone is enough to be a message; the rejection above must
    // not catch legitimate minimal mail.
    const parsed = await parseMessage(rawFrom('From: a@b.example\n\njust a body\n'));
    expect(parsed.fromAddress).toBe('a@b.example');
  });

  it('stores a placeholder rather than dropping a message with no From', async () => {
    const parsed = await parseMessage(rawFrom('Subject: orphan\nDate: Mon, 17 Aug 2026 09:00:00 +0000\n\nbody\n'));
    expect(parsed.fromAddress).toBe('unknown@invalid');
  });
});

describe('snippetOf', () => {
  it('skips quoted reply text', async () => {
    const parsed = withSnippet(await parseMessage(await rawOf('02-invoice-reply.eml')));
    expect(parsed.snippet).not.toContain('Invoice 4471 for');
  });

  it('skips the attribution line', async () => {
    const parsed = withSnippet(await parseMessage(await rawOf('02-invoice-reply.eml')));
    expect(parsed.snippet.toLowerCase()).not.toContain('wrote:');
  });

  it('skips forwarded-message headers', () => {
    const snippet = snippetOf('----- Forwarded message -----\nFrom: a@b\nReal content here');
    expect(snippet).not.toContain('Forwarded');
    expect(snippet).not.toContain('From:');
    expect(snippet).toContain('Real content here');
  });

  it('truncates a long body with an ellipsis', () => {
    expect(snippetOf('word '.repeat(200)).endsWith('...')).toBe(true);
  });

  it('returns empty for an empty body', () => {
    expect(snippetOf('')).toBe('');
    expect(snippetOf('\n\n   \n')).toBe('');
  });

  it('collapses a multi-line body onto one line', () => {
    expect(snippetOf('first line\nsecond line')).toBe('first line second line');
  });
});
