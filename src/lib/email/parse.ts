import { createHash } from 'node:crypto';

import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

import { stripHtml } from '@/lib/documents/parse';
import { MailError, type RawMessage } from './types';

export interface ParsedEmail {
  /** Dedupe key: the Message-ID header, or a content hash when it is missing. */
  messageId: string;
  externalId: string | null;
  /** Root of the reply chain, so a conversation can be grouped. */
  threadKey: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  snippet: string;
  attachmentNames: string[];
  labels: string[];
  receivedAt: Date;
  /**
   * Where `receivedAt` came from.
   *
   * This matters for the sync cursor: `fallback` means "we had nothing and used
   * the current time", and advancing an incremental cursor to *now* would make
   * every legitimately older message look already-seen on the next run.
   */
  receivedAtSource: 'header' | 'provider' | 'fallback';
}

/** Bodies are capped so one newsletter cannot dominate a prompt or a row. */
const MAX_BODY_CHARS = 60_000;
const SNIPPET_CHARS = 220;

export async function parseMessage(message: RawMessage): Promise<ParsedEmail> {
  let mail: ParsedMail;
  try {
    mail = await simpleParser(Buffer.from(message.raw), {
      // Attachment bytes are never stored, so there is no reason to buffer them.
      skipImageLinks: true,
      skipTextLinks: true,
    });
  } catch (error) {
    throw new MailError(
      `Could not parse message ${message.externalId}: ${error instanceof Error ? error.message : error}`,
    );
  }

  // mailparser is lenient by design: handed arbitrary bytes it returns a
  // message-shaped object with every field empty, dated now. Stored, that
  // becomes a junk row whose "received" time is the present — which then drags
  // the sync cursor forward and hides real mail. A message with no From, no
  // Message-ID, no Subject and no Date is not a message.
  if (!mail.from && !mail.messageId && !mail.subject && !mail.date) {
    throw new MailError(
      `Message ${message.externalId} has no recognisable headers; it is not a mail message.`,
    );
  }

  const from = firstAddress(mail.from);

  const receivedAt = mail.date ?? message.receivedAt ?? new Date();
  const receivedAtSource = mail.date ? 'header' : message.receivedAt ? 'provider' : 'fallback';

  return {
    messageId: normaliseMessageId(mail.messageId) ?? hashOf(message.raw),
    externalId: message.externalId || null,
    threadKey: threadKeyOf(mail),
    // A message with no usable From is malformed but should still be readable,
    // so it is stored with a placeholder rather than dropped.
    fromAddress: from.address ?? 'unknown@invalid',
    fromName: from.name,
    toAddresses: allAddresses(mail.to),
    ccAddresses: allAddresses(mail.cc),
    subject: (mail.subject ?? '').trim().slice(0, 500),
    bodyText: bodyTextOf(mail),
    snippet: '',
    attachmentNames: (mail.attachments ?? [])
      .map((attachment) => attachment.filename ?? '(unnamed)')
      .slice(0, 30),
    labels: message.labels ?? [],
    receivedAt,
    receivedAtSource,
  };
}

/** Fill in the snippet once the body is final. Kept separate so it is testable. */
export function withSnippet(email: ParsedEmail): ParsedEmail {
  return { ...email, snippet: snippetOf(email.bodyText) };
}

function normaliseMessageId(messageId: string | undefined): string | null {
  const trimmed = messageId?.trim();
  if (!trimmed) return null;
  // Strip the angle brackets so the stored value is stable regardless of whether
  // a provider includes them.
  return trimmed.replace(/^<|>$/g, '').slice(0, 500) || null;
}

function hashOf(raw: Uint8Array): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

/**
 * Group a conversation by the first id in its reply chain.
 *
 * `References` holds the chain oldest-first, so its head is the thread root.
 * `In-Reply-To` is the fallback, and a message that starts a thread is its own
 * root.
 */
function threadKeyOf(mail: ParsedMail): string | null {
  const references = mail.references;
  const list = typeof references === 'string' ? [references] : (references ?? []);
  const root = list[0] ?? mail.inReplyTo ?? mail.messageId;
  return normaliseMessageId(root);
}

interface SimpleAddress {
  address: string | null;
  name: string | null;
}

function firstAddress(field: AddressObject | AddressObject[] | undefined): SimpleAddress {
  const values = toAddressArray(field);
  const first = values[0];
  if (!first) return { address: null, name: null };
  return {
    address: first.address?.toLowerCase().trim() ?? null,
    name: first.name?.trim() || null,
  };
}

function allAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  const values = toAddressArray(field)
    .map((entry) => entry.address?.toLowerCase().trim())
    .filter((address): address is string => address !== undefined && address.length > 0);
  return [...new Set(values)].slice(0, 50);
}

function toAddressArray(
  field: AddressObject | AddressObject[] | undefined,
): Array<{ address?: string; name?: string }> {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  return objects.flatMap((object) => object.value ?? []);
}

/**
 * Get readable text out of a message.
 *
 * HTML-only mail is extremely common, so falling back to the HTML part and
 * stripping it is the difference between reading most of a mailbox and reading
 * a third of it.
 */
function bodyTextOf(mail: ParsedMail): string {
  const plain = mail.text?.trim();
  if (plain && plain.length > 0) return clampBody(plain);

  if (mail.html && typeof mail.html === 'string') {
    const stripped = stripHtml(mail.html).text.trim();
    if (stripped.length > 0) return clampBody(stripped);
  }

  const fallback = mail.textAsHtml?.trim();
  if (fallback) return clampBody(stripHtml(fallback).text.trim());

  return '';
}

function clampBody(text: string): string {
  const normalised = text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    // Collapse the long runs of blank lines that quoted replies produce.
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  return normalised.length <= MAX_BODY_CHARS
    ? normalised
    : `${normalised.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
}

/**
 * Build a one-line preview.
 *
 * Quoted replies and forwarded headers are skipped, because a snippet reading
 * "On Tuesday, someone wrote:" tells the user nothing about the message.
 */
export function snippetOf(bodyText: string): string {
  const lines = bodyText.split('\n');
  const useful: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('>')) continue;
    if (/^on .{4,80}\bwrote:$/i.test(trimmed)) continue;
    if (/^-{2,}\s*(original message|forwarded message)/i.test(trimmed)) continue;
    if (/^(from|sent|to|cc|subject|date):/i.test(trimmed)) continue;

    useful.push(trimmed);
    if (useful.join(' ').length >= SNIPPET_CHARS) break;
  }

  const snippet = useful.join(' ').slice(0, SNIPPET_CHARS);
  return snippet.length === SNIPPET_CHARS ? `${snippet}...` : snippet;
}
