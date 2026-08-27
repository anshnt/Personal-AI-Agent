import { describe, expect, it } from 'vitest';

import { chunkText } from './chunk';

const paragraphs = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} with enough words in it to take up real space in the document.`,
).join('\n\n');

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('One short paragraph.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.charOffset).toBe(0);
    expect(chunks[0]?.ordinal).toBe(0);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('')).toHaveLength(0);
    expect(chunkText('   \n  ')).toHaveLength(0);
  });

  it('splits long text', () => {
    expect(chunkText(paragraphs, { size: 600, overlap: 100 }).length).toBeGreaterThan(3);
  });

  it('numbers chunks sequentially from zero', () => {
    const chunks = chunkText(paragraphs, { size: 600, overlap: 100 });
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  it('advances the offset on every chunk', () => {
    const chunks = chunkText(paragraphs, { size: 600, overlap: 100 });
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index]!.charOffset).toBeGreaterThan(chunks[index - 1]!.charOffset);
    }
  });

  it('respects the size budget', () => {
    for (const chunk of chunkText(paragraphs, { size: 600, overlap: 100 })) {
      expect(chunk.content.length).toBeLessThanOrEqual(700);
    }
  });

  it('starts every chunk at a word boundary', () => {
    // Overlap means later chunks start mid-document, but never mid-word: a chunk
    // reading "pace in the document" retrieves badly and cannot be quoted.
    for (const chunk of chunkText(paragraphs, { size: 600, overlap: 100 })) {
      if (chunk.charOffset === 0) continue;
      expect(paragraphs[chunk.charOffset - 1], JSON.stringify(chunk.content.slice(0, 20))).toMatch(/\s/);
    }
  });

  it('overlaps consecutive chunks', () => {
    // Without overlap, "the deadline is" and "March 14th" land either side of a
    // boundary and neither matches a query for the deadline.
    const chunks = chunkText(paragraphs, { size: 600, overlap: 100 });
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      expect(chunks[index]!.charOffset).toBeLessThan(previous.charOffset + previous.content.length);
    }
  });

  it('terminates on a single unbreakable run longer than the chunk size', () => {
    const chunks = chunkText('x'.repeat(5000), { size: 400, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(40);
  });

  it('clamps an absurd overlap rather than looping', () => {
    // An overlap at or above the chunk size would mean zero forward progress.
    const chunks = chunkText(paragraphs, { size: 400, overlap: 10_000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(200);
  });

  it('covers the whole document', () => {
    const chunks = chunkText(paragraphs, { size: 600, overlap: 100 });
    const last = chunks[chunks.length - 1]!;
    expect(last.charOffset + last.content.length).toBeGreaterThanOrEqual(paragraphs.trim().length - 2);
  });
});
