import { generateObject } from 'ai';
import { z } from 'zod';

import { MEMORY_EXTRACTION_PROMPT } from '@/lib/ai/prompts';
import { utilityModel, utilityProviderOptions } from '@/lib/ai/provider';
import type { Memory } from '@/lib/db/schema';
import { backfillEmbeddings } from './semantic';
import { recall, remember } from './store';

const extractedMemory = z.object({
  content: z
    .string()
    .min(4)
    .max(400)
    .describe('One self-contained sentence in the third person, about "the user".'),
  kind: z.enum(['fact', 'preference', 'episode', 'directive']),
  importance: z.number().min(0).max(1),
  tags: z.array(z.string().min(1).max(24)).max(4).default([]),
});

const extractionResult = z.object({
  memories: z.array(extractedMemory).max(6),
});

export interface ExtractionInput {
  userId: string;
  conversationId: string;
  userText: string;
  assistantText: string;
}

/**
 * Mine one exchange for durable memories and persist them.
 *
 * This runs after the response has already been streamed to the user, so it is
 * never on the critical path. It is also fully best-effort: a failure here must
 * not surface as a failed conversation, because the user already has their
 * answer. Failures are logged and swallowed.
 */
export async function extractAndStoreMemories(input: ExtractionInput): Promise<Memory[]> {
  const userText = input.userText.trim();
  if (userText.length < 8) {
    // "ok", "thanks", "yes" — nothing durable to learn.
    return [];
  }

  try {
    // Show the extractor what is already known so it does not restate it.
    const existing = await recall({ userId: input.userId, query: userText, limit: 10 });
    const knownBlock =
      existing.length > 0
        ? existing.map((memory) => `- ${memory.content}`).join('\n')
        : '(nothing recorded yet)';

    const { object } = await generateObject({
      model: utilityModel(),
      schema: extractionResult,
      system: MEMORY_EXTRACTION_PROMPT,
      providerOptions: utilityProviderOptions(),
      prompt: [
        '# Already remembered',
        knownBlock,
        '',
        '# The exchange',
        `User: ${userText}`,
        `Assistant: ${truncate(input.assistantText, 4000)}`,
      ].join('\n'),
    });

    const stored: Memory[] = [];
    for (const candidate of object.memories) {
      // The model occasionally emits second-person phrasing despite the prompt;
      // a memory that reads as "you like X" is ambiguous once out of context.
      const content = candidate.content.trim();
      if (content.length === 0) continue;

      stored.push(
        await remember({
          userId: input.userId,
          content,
          kind: candidate.kind,
          importance: candidate.importance,
          tags: candidate.tags,
          source: `conversation:${input.conversationId}`,
        }),
      );
    }

    if (stored.length > 0) {
      // Embedded here rather than in `remember`, for two reasons: this already
      // runs after the response is delivered, so latency does not reach the
      // user; and a batch of new memories is one provider call instead of
      // several. It is a no-op when semantic recall is not configured.
      const result = await backfillEmbeddings(input.userId, stored.length + 5);
      if (result.reason && result.skipped > 0) {
        console.warn('[memory] embeddings were skipped:', result.reason);
      }
    }

    return stored;
  } catch (error) {
    console.error('[memory] extraction failed', error);
    return [];
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[...truncated]`;
}
