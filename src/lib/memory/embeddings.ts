import { env } from '@/lib/env';

/**
 * Text embeddings, for semantic memory recall.
 *
 * Anthropic publishes no embedding model — the provider's `textEmbeddingModel`
 * returns `never` — so this needs a second vendor. Voyage is Anthropic's
 * recommended partner and is the default; OpenAI is supported as an
 * alternative. Both are optional: with neither configured, recall stays purely
 * lexical and nothing here is ever called.
 *
 * The dimension is fixed at 1024 because a pgvector column and its index need a
 * fixed width, and both providers can be asked for exactly that. Switching
 * providers therefore means re-embedding, which is why the model name is stored
 * alongside every vector.
 */

export const EMBEDDING_DIMENSIONS = 1024;

export class EmbeddingError extends Error {}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** Embed a batch. Order of the result matches the order of the input. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Cap on one batch, to stay inside provider request limits. */
const MAX_BATCH = 64;

/* -------------------------------------------------------------------------- */
/* Voyage                                                                     */
/* -------------------------------------------------------------------------- */

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  detail?: string;
}

class VoyageProvider implements EmbeddingProvider {
  readonly name = 'voyage';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        // Memories are what gets stored; a query is embedded separately with
        // input_type 'query', which is what these models are tuned for.
        input_type: 'document',
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => {
      throw new EmbeddingError(
        `Voyage is unreachable: ${error instanceof Error ? error.message : error}`,
      );
    });

    const body = (await response.json().catch(() => ({}))) as VoyageResponse;

    if (!response.ok) {
      throw new EmbeddingError(
        response.status === 401
          ? 'Voyage rejected the API key. Check VOYAGE_API_KEY.'
          : `Voyage returned ${response.status}: ${body.detail ?? 'no detail'}`,
      );
    }

    return orderedVectors(body.data ?? [], texts.length, 'Voyage');
  }
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

interface OpenAiResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

class OpenAiProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        // Matryoshka truncation, so the fixed column width is satisfied without
        // a different model.
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => {
      throw new EmbeddingError(
        `OpenAI is unreachable: ${error instanceof Error ? error.message : error}`,
      );
    });

    const body = (await response.json().catch(() => ({}))) as OpenAiResponse;

    if (!response.ok) {
      throw new EmbeddingError(
        response.status === 401
          ? 'OpenAI rejected the API key. Check OPENAI_API_KEY.'
          : `OpenAI returned ${response.status}: ${body.error?.message ?? 'no detail'}`,
      );
    }

    return orderedVectors(body.data ?? [], texts.length, 'OpenAI');
  }
}

/**
 * Put a provider's vectors back into request order and check their shape.
 *
 * Both APIs return an `index` per item and are documented to preserve order,
 * but relying on that silently mis-attributes every embedding if it ever
 * changes — and a mis-attributed memory vector is a recall bug that looks like
 * the model hallucinating.
 */
function orderedVectors(
  data: Array<{ embedding?: number[]; index?: number }>,
  expected: number,
  providerName: string,
): number[][] {
  if (data.length !== expected) {
    throw new EmbeddingError(
      `${providerName} returned ${data.length} embeddings for ${expected} inputs.`,
    );
  }

  const result = new Array<number[] | undefined>(expected);

  data.forEach((entry, position) => {
    const index = entry.index ?? position;
    if (!Array.isArray(entry.embedding)) {
      throw new EmbeddingError(`${providerName} returned an entry with no embedding.`);
    }
    if (entry.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError(
        `${providerName} returned ${entry.embedding.length} dimensions; ${EMBEDDING_DIMENSIONS} were requested.`,
      );
    }
    if (index < 0 || index >= expected) {
      throw new EmbeddingError(`${providerName} returned an out-of-range index ${index}.`);
    }
    result[index] = entry.embedding;
  });

  const missing = result.findIndex((vector) => vector === undefined);
  if (missing !== -1) {
    throw new EmbeddingError(`${providerName} returned no embedding for input ${missing}.`);
  }

  return result as number[][];
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/** The configured provider, or undefined when semantic recall is switched off. */
export function embeddingProvider(): EmbeddingProvider | undefined {
  const voyageKey = env.voyageApiKey;
  if (voyageKey) return new VoyageProvider(voyageKey, env.voyageEmbeddingModel);

  const openAiKey = env.openAiApiKey;
  if (openAiKey) return new OpenAiProvider(openAiKey, env.openAiEmbeddingModel);

  return undefined;
}

/**
 * Embed a batch, chunked to the provider's practical limit.
 *
 * `undefined` when no provider is configured, so callers can treat semantic
 * recall as absent rather than having to know why.
 */
export async function embedTexts(texts: string[]): Promise<number[][] | undefined> {
  const provider = embeddingProvider();
  if (!provider || texts.length === 0) return undefined;

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += MAX_BATCH) {
    const batch = texts.slice(start, start + MAX_BATCH);
    vectors.push(...(await provider.embed(batch)));
  }
  return vectors;
}

export async function embedOne(text: string): Promise<number[] | undefined> {
  const vectors = await embedTexts([text]);
  return vectors?.[0];
}

/** Render a vector as a pgvector literal. */
export function toVectorLiteral(vector: number[]): string {
  // pgvector accepts a bracketed, comma-separated list. Non-finite values would
  // be rejected by the server, so they are caught here with a clearer message.
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingError('An embedding contained a non-finite value.');
    }
  }
  return `[${vector.join(',')}]`;
}
