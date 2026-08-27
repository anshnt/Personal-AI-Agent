import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  embedOne,
  embedTexts,
  embeddingProvider,
  toVectorLiteral,
} from './embeddings';

/**
 * Provider selection and response handling.
 *
 * The HTTP calls are faked, which is the right level: what can be wrong here is
 * how a response is validated and re-ordered, not whether Voyage is reachable.
 */

const KEYS = ['VOYAGE_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_EMBEDDING_MODEL', 'OPENAI_EMBEDDING_MODEL'];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) saved.set(key, process.env[key]);
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

const vector = (fill: number) => new Array<number>(EMBEDDING_DIMENSIONS).fill(fill);

interface StubCall {
  url: unknown;
  init: { body: string };
}

function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: StubCall[] = [];
  const fetchMock = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url, init: init as { body: string } });
    return { ok, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('embeddingProvider', () => {
  it('is undefined with nothing configured, so recall stays lexical', () => {
    expect(embeddingProvider()).toBeUndefined();
  });

  it('prefers Voyage, which is the Anthropic-recommended partner', () => {
    process.env.VOYAGE_API_KEY = 'v';
    process.env.OPENAI_API_KEY = 'o';
    expect(embeddingProvider()?.name).toBe('voyage');
  });

  it('falls back to OpenAI when only that key is present', () => {
    process.env.OPENAI_API_KEY = 'o';
    expect(embeddingProvider()?.name).toBe('openai');
  });

  it('uses the default model, and honours an override', () => {
    process.env.VOYAGE_API_KEY = 'v';
    expect(embeddingProvider()?.model).toBe('voyage-3.5');
    process.env.VOYAGE_EMBEDDING_MODEL = 'voyage-3-large';
    expect(embeddingProvider()?.model).toBe('voyage-3-large');
  });
});

describe('embedTexts', () => {
  it('returns undefined with no provider, rather than throwing', async () => {
    await expect(embedTexts(['a'])).resolves.toBeUndefined();
  });

  it('returns undefined for an empty input', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    await expect(embedTexts([])).resolves.toBeUndefined();
  });

  it('asks for the fixed dimension the column requires', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    const calls = stubFetch({ data: [{ embedding: vector(0.1), index: 0 }] });
    await embedTexts(['a']);

    const first = calls[0];
    expect(first).toBeDefined();
    const body = JSON.parse(first!.init.body) as { output_dimension: number };
    expect(body.output_dimension).toBe(EMBEDDING_DIMENSIONS);
  });

  it('re-orders by the index the provider reports', async () => {
    // Both APIs document order preservation, but relying on it silently
    // mis-attributes every vector if that ever changes — and a mis-attributed
    // memory vector is a recall bug that reads as the model hallucinating.
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({
      data: [
        { embedding: vector(0.3), index: 2 },
        { embedding: vector(0.1), index: 0 },
        { embedding: vector(0.2), index: 1 },
      ],
    });

    const vectors = await embedTexts(['first', 'second', 'third']);
    expect(vectors?.[0]?.[0]).toBeCloseTo(0.1);
    expect(vectors?.[1]?.[0]).toBeCloseTo(0.2);
    expect(vectors?.[2]?.[0]).toBeCloseTo(0.3);
  });

  it('rejects a count mismatch', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ data: [{ embedding: vector(0.1), index: 0 }] });
    await expect(embedTexts(['a', 'b'])).rejects.toThrow(/2 inputs/);
  });

  it('rejects a wrong dimension', async () => {
    // A silently truncated vector would sit in the column and poison every
    // comparison against it.
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ data: [{ embedding: [0.1, 0.2], index: 0 }] });
    await expect(embedTexts(['a'])).rejects.toThrow(/2 dimensions/);
  });

  it('rejects an out-of-range index', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ data: [{ embedding: vector(0.1), index: 7 }] });
    await expect(embedTexts(['a'])).rejects.toThrow(/out-of-range/);
  });

  it('rejects an entry with no embedding', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ data: [{ index: 0 }] });
    await expect(embedTexts(['a'])).rejects.toThrow(EmbeddingError);
  });

  it('names the variable to fix on a rejected key', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ detail: 'bad key' }, false, 401);
    await expect(embedTexts(['a'])).rejects.toThrow(/VOYAGE_API_KEY/);
  });

  it('names the OpenAI variable on a rejected OpenAI key', async () => {
    process.env.OPENAI_API_KEY = 'o';
    stubFetch({ error: { message: 'bad key' } }, false, 401);
    await expect(embedTexts(['a'])).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('reports a non-auth failure with its status', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ detail: 'slow down' }, false, 429);
    await expect(embedTexts(['a'])).rejects.toThrow(/429/);
  });

  it('batches a large input rather than sending one huge request', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { input: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: body.input.map((_, index) => ({ embedding: vector(0.1), index })),
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const vectors = await embedTexts(Array.from({ length: 150 }, (_, i) => `text ${i}`));
    expect(vectors).toHaveLength(150);
    // 150 items at a batch size of 64 is three requests.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('embedOne returns the single vector', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    stubFetch({ data: [{ embedding: vector(0.5), index: 0 }] });
    expect((await embedOne('a'))?.[0]).toBeCloseTo(0.5);
  });
});

describe('toVectorLiteral', () => {
  it('renders the bracketed form pgvector expects', () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe('[1,2.5,-3]');
  });

  it('rejects a non-finite value with a clear message', () => {
    // The server would reject these too, but with a far less useful error.
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(/non-finite/);
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
  });

  it('handles an empty vector', () => {
    expect(toVectorLiteral([])).toBe('[]');
  });
});
