import { tool } from 'ai';
import { z } from 'zod';

import { updateUserProfile, setUserIdentity } from '@/lib/db/users';
import {
  forgetMatching,
  forgetMemory,
  listMemories,
  recall,
  remember,
  reviseMemory,
} from '@/lib/memory/store';
import { failure, instrument, type AgentContext } from './context';
import { id, isoDateTime } from './schemas';

const memoryKind = z.enum(['fact', 'preference', 'episode', 'directive']);

export function memoryTools(context: AgentContext) {
  return {
    remember_this: tool({
      description:
        'Save something about the user to long-term memory. Use it for stable facts, standing preferences, commitments, and corrections — anything that should still be known in a future conversation. Write the memory as one self-contained sentence in the third person.',
      inputSchema: z.object({
        content: z
          .string()
          .min(4)
          .max(400)
          .describe('One self-contained sentence about the user, in the third person.'),
        kind: memoryKind
          .default('fact')
          .describe(
            'fact: durable and atemporal. preference: how you should behave. episode: something that happened. directive: a standing instruction.',
          ),
        importance: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe('Above 0.8 only for things that should shape almost every future answer.'),
        tags: z.array(z.string().min(1).max(24)).max(4).default([]),
        expires_at: isoDateTime
          .optional()
          .describe('ISO 8601. Set this for time-boxed facts, e.g. "is on holiday until Friday".'),
      }),
      execute: instrument('remember_this', context, async (input) => {
        const stored = await remember({
          userId: context.user.id,
          content: input.content,
          kind: input.kind,
          importance: input.importance,
          tags: input.tags,
          source: `conversation:${context.conversationId}`,
          expiresAt: input.expires_at ? new Date(input.expires_at) : null,
        });

        return { ok: true as const, memory_id: stored.id, content: stored.content };
      }),
    }),

    search_memory: tool({
      description:
        'Search long-term memory about the user. The memories already in your context are a partial recall, so search whenever you need something specific that is not there. Omit the query to get the highest-signal memories.',
      inputSchema: z.object({
        query: z.string().max(300).optional().describe('Natural language. Omit for a general overview.'),
        kinds: z.array(memoryKind).max(4).optional(),
        tags: z.array(z.string().min(1).max(24)).max(4).optional(),
        limit: z.number().int().min(1).max(50).default(12),
      }),
      execute: instrument('search_memory', context, async (input) => {
        const found = await recall({
          userId: context.user.id,
          query: input.query,
          kinds: input.kinds,
          tags: input.tags,
          limit: input.limit,
        });

        return {
          ok: true as const,
          count: found.length,
          memories: found.map((memory) => ({
            id: memory.id,
            kind: memory.kind,
            content: memory.content,
            tags: memory.tags,
            relevance: Number(memory.score.toFixed(3)),
            recorded_at: memory.createdAt.toISOString(),
          })),
        };
      }),
    }),

    revise_memory: tool({
      description:
        'Correct a memory that is now wrong or out of date. Prefer this over saving a second, contradicting memory. The old version is retained but stops being recalled.',
      inputSchema: z.object({
        memory_id: id.describe('From search_memory.'),
        content: z.string().min(4).max(400).describe('The corrected sentence.'),
      }),
      execute: instrument('revise_memory', context, async (input) => {
        const replacement = await reviseMemory(context.user.id, input.memory_id, input.content);
        return { ok: true as const, memory_id: replacement.id, content: replacement.content };
      }),
    }),

    forget: tool({
      description:
        'Delete memories permanently. Use it only when the user asks you to forget something. Pass memory_id when you know it; otherwise pass a description and only confident matches are removed.',
      inputSchema: z.object({
        memory_id: id.optional(),
        describes: z.string().max(300).optional().describe('What to forget, if you have no id.'),
      }),
      execute: instrument('forget', context, async (input) => {
        if (input.memory_id) {
          const deleted = await forgetMemory(context.user.id, input.memory_id);
          return deleted
            ? { ok: true as const, deleted: 1, contents: [] as string[] }
            : failure('No memory with that id belongs to this user.');
        }

        if (!input.describes) {
          return failure('Pass either memory_id or describes.');
        }

        const removed = await forgetMatching(context.user.id, input.describes);
        if (removed.length === 0) {
          return failure(
            'Nothing matched confidently enough to delete. Use search_memory and pass an explicit memory_id.',
          );
        }

        return {
          ok: true as const,
          deleted: removed.length,
          contents: removed.map((memory) => memory.content),
        };
      }),
    }),

    list_memory: tool({
      description:
        'List stored memories, optionally filtered by kind. Use it when the user asks what you know or remember about them.',
      inputSchema: z.object({
        kind: memoryKind.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: instrument('list_memory', context, async (input) => {
        const rows = await listMemories(context.user.id, { kind: input.kind, limit: input.limit });
        return {
          ok: true as const,
          count: rows.length,
          memories: rows.map((memory) => ({
            id: memory.id,
            kind: memory.kind,
            content: memory.content,
            tags: memory.tags,
            importance: memory.importance,
            recorded_at: memory.createdAt.toISOString(),
          })),
        };
      }),
    }),

    update_profile: tool({
      description:
        "Update the user's core identity or structured profile. Use it for their name, timezone, and durable attributes like role or working hours — not for one-off facts, which belong in remember_this.",
      inputSchema: z.object({
        name: z.string().min(1).max(120).optional(),
        timezone: z
          .string()
          .min(3)
          .max(64)
          .optional()
          .describe('IANA timezone, e.g. Europe/Berlin.'),
        profile: z
          .record(z.string().min(1).max(48), z.unknown())
          .optional()
          .describe('Merged into the existing profile. Pass null for a key to remove it.'),
      }),
      execute: instrument('update_profile', context, async (input) => {
        if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
          return failure(`"${input.timezone}" is not a valid IANA timezone.`);
        }

        let user = context.user;
        if (input.name !== undefined || input.timezone !== undefined) {
          user = await setUserIdentity(user.id, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          });
        }
        if (input.profile !== undefined) {
          user = await updateUserProfile(user.id, input.profile);
        }

        // Keep the in-flight turn consistent with what was just written.
        context.user = user;

        return {
          ok: true as const,
          name: user.name,
          timezone: user.timezone,
          profile: user.profile,
        };
      }),
    }),
  };
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
