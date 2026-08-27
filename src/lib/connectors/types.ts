import type { z } from 'zod';

/**
 * The connector contract.
 *
 * The alternative design — one generic `http_request` tool the model points
 * wherever it likes — is rejected deliberately. It would mean the model
 * composing URLs (an SSRF surface), holding credentials in its context (a
 * leak waiting to happen), and reaching any endpoint of any service it can
 * name (unbounded blast radius from one prompt injection).
 *
 * Here the model picks a *named operation* and supplies validated parameters.
 * It never sees a credential, never builds a URL, and cannot reach a host or a
 * path that was not declared up front.
 */

export class ConnectorError extends Error {}

/** How a connector's credential is attached to the request. */
export type AuthScheme =
  | { kind: 'none' }
  /** `Authorization: <prefix> <token>` */
  | { kind: 'bearer'; envVar: string; prefix?: string }
  /** An arbitrary header, e.g. `X-Api-Key`. */
  | { kind: 'header'; envVar: string; header: string }
  /** A query parameter. Least preferred: query strings end up in logs. */
  | { kind: 'query'; envVar: string; parameter: string };

export interface OperationDefinition {
  /** Stable name the model uses. */
  name: string;
  /** What it does, written for the model to choose by. */
  description: string;
  method: 'GET' | 'POST';
  /**
   * Path template relative to the connector's base URL.
   *
   * `{name}` placeholders are filled from validated parameters and
   * percent-encoded. A parameter can therefore never inject a path segment.
   */
  path: string;
  /** Parameter schema. Anything not declared here is rejected. */
  input: z.ZodType<Record<string, unknown>>;
  /**
   * Parameters that go in the query string rather than the path.
   * Anything not listed and not a path placeholder goes in the JSON body.
   */
  query?: string[];
  /**
   * True when the operation changes something on the other end.
   *
   * Writes are refused unless the caller passes explicit confirmation, so a
   * prompt injection in a web page cannot make the agent post on the user's
   * behalf without the user having said so.
   */
  mutates?: boolean;
  /** Trim a large response down to what is useful. */
  summarise?: (body: unknown) => unknown;
}

export interface ConnectorDefinition {
  name: string;
  description: string;
  /** Absolute https base. Every operation path is resolved against it. */
  baseUrl: string;
  auth: AuthScheme;
  operations: OperationDefinition[];
  /** Calls allowed per user per window. */
  rateLimit: { calls: number; windowSeconds: number };
  /** Shown when the connector is unavailable because its key is missing. */
  setupHint?: string;
}

export interface InvokeResult {
  connector: string;
  operation: string;
  status: number;
  /** The response, after the connector's own summarising. */
  data: unknown;
  /** Requests remaining in the current window. */
  remaining: number;
}
