/**
 * Split document text into overlapping retrieval chunks.
 *
 * The split points are chosen to keep chunks readable on their own: paragraph
 * boundaries first, then sentences, then a hard cut. A chunk that begins
 * mid-sentence is one the agent will quote badly.
 */

export interface Chunk {
  ordinal: number;
  content: string;
  /** Character offset into the original text, so callers can read around a hit. */
  charOffset: number;
}

export interface ChunkOptions {
  /** Target chunk size in characters. */
  size?: number;
  /**
   * Characters of the previous chunk to repeat at the start of the next one.
   *
   * Overlap is what stops a fact that straddles a boundary from becoming
   * unretrievable: without it, "the deadline is" and "March 14th" end up in
   * different chunks and neither matches a query for the deadline.
   */
  overlap?: number;
}

const DEFAULT_SIZE = 1400;
const DEFAULT_OVERLAP = 200;

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const size = Math.max(options.size ?? DEFAULT_SIZE, 200);
  const overlap = Math.min(Math.max(options.overlap ?? DEFAULT_OVERLAP, 0), Math.floor(size / 2));

  const normalised = text.trim();
  if (normalised.length === 0) return [];
  if (normalised.length <= size) {
    return [{ ordinal: 0, content: normalised, charOffset: 0 }];
  }

  const chunks: Chunk[] = [];
  let cursor = 0;
  let ordinal = 0;

  while (cursor < normalised.length) {
    const hardEnd = Math.min(cursor + size, normalised.length);
    const end = hardEnd === normalised.length ? hardEnd : findBreak(normalised, cursor, hardEnd);

    const content = normalised.slice(cursor, end).trim();
    if (content.length > 0) {
      chunks.push({ ordinal, content, charOffset: cursor });
      ordinal += 1;
    }

    if (end >= normalised.length) break;

    // Step forward by at least one character so a pathological input — a single
    // unbroken token longer than the chunk size — cannot loop forever.
    const overlapStart = Math.max(end - overlap, cursor + 1);
    cursor = snapForwardToBoundary(normalised, overlapStart, end);
  }

  return chunks;
}

/**
 * Move a chunk start forward to the nearest clean boundary.
 *
 * Without this the overlap region begins wherever `end - overlap` happens to
 * land, which is usually mid-word: a chunk that starts "pace in the document"
 * retrieves poorly and is impossible for the agent to quote. Snapping never
 * moves backwards, so forward progress through the text is preserved.
 */
function snapForwardToBoundary(text: string, from: number, limit: number): number {
  const sentence = firstSentenceStart(text, from, limit);
  if (sentence !== -1) return sentence;

  for (let index = from; index < limit; index += 1) {
    const char = text[index];
    if (char === ' ' || char === '\n') {
      // Skip the whole run of whitespace so the chunk starts on a word.
      let next = index + 1;
      while (next < limit && (text[next] === ' ' || text[next] === '\n')) next += 1;
      return next < limit ? next : from;
    }
  }

  // No boundary inside the overlap window: keep the unsnapped start.
  return from;
}

/** First position after a sentence terminator within `[from, limit)`. */
function firstSentenceStart(text: string, from: number, limit: number): number {
  for (let index = from; index < limit - 1; index += 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?') continue;
    if (text[index + 1] !== ' ' && text[index + 1] !== '\n') continue;

    let next = index + 1;
    while (next < limit && (text[next] === ' ' || text[next] === '\n')) next += 1;
    if (next < limit) return next;
  }
  return -1;
}

/**
 * Find the best place to end a chunk within `[start, limit)`.
 *
 * Only the last third of the window is considered, so a break is never taken so
 * early that it produces a tiny chunk.
 */
function findBreak(text: string, start: number, limit: number): number {
  const earliest = start + Math.floor((limit - start) * 0.66);

  const paragraph = text.lastIndexOf('\n\n', limit);
  if (paragraph >= earliest) return paragraph + 2;

  const sentence = lastSentenceEnd(text, earliest, limit);
  if (sentence !== -1) return sentence;

  const newline = text.lastIndexOf('\n', limit);
  if (newline >= earliest) return newline + 1;

  const space = text.lastIndexOf(' ', limit);
  if (space >= earliest) return space + 1;

  // No usable boundary: cut hard rather than growing the chunk unboundedly.
  return limit;
}

function lastSentenceEnd(text: string, earliest: number, limit: number): number {
  for (let index = limit - 1; index >= earliest; index -= 1) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?') continue;

    const next = text[index + 1];
    // A terminator only ends a sentence if whitespace follows it, which keeps
    // "3.14", "e.g." and "file.txt" from being treated as boundaries.
    if (next === undefined || next === ' ' || next === '\n') {
      return index + 1;
    }
  }
  return -1;
}
