/**
 * The provider contract.
 *
 * Providers do one thing: hand back raw RFC 5322 bytes. Parsing, normalising,
 * deduping and storing all happen in one shared pipeline, so adding a provider
 * cannot introduce a second, subtly different interpretation of a message — and
 * so the interesting logic stays testable without a mail server.
 */

export interface RawMessage {
  /** Provider-native identifier: an IMAP UID, a filename, an API id. */
  externalId: string;
  /** The complete message, headers and body. */
  raw: Uint8Array;
  /**
   * Server-side timestamp, when the provider knows it.
   *
   * Used only as a fallback: the parsed `Date` header is preferred, because it
   * is what the user will recognise as when the mail was sent.
   */
  receivedAt?: Date;
  /** Provider-side labels or flags, when it has them. */
  labels?: string[];
}

export interface FetchOptions {
  /** Only messages newer than this. Providers should filter server-side. */
  since?: Date;
  /** Hard cap on messages returned in one call. */
  limit: number;
}

export interface MailProvider {
  readonly kind: 'imap' | 'local';
  /** Human-readable description of where mail is coming from, for errors. */
  readonly describe: string;
  fetch(options: FetchOptions): Promise<RawMessage[]>;
  /** Release connections. Always called, including after a failed fetch. */
  close(): Promise<void>;
}

export class MailError extends Error {}
