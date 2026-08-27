import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { z } from 'zod';

import { buildSystemPrompt } from '@/lib/ai/prompts';
import { agentModel, agentProviderOptions } from '@/lib/ai/provider';
import {
  ensureConversation,
  maybeTitleConversation,
  saveMessages,
  textOf,
} from '@/lib/conversations';
import { resolveCurrentUser } from '@/lib/db/users';
import { env } from '@/lib/env';
import { extractAndStoreMemories } from '@/lib/memory/extract';
import { recall } from '@/lib/memory/store';
import { openTaskSummaries } from '@/lib/tasks/store';
import { buildTools } from '@/lib/tools';

export const maxDuration = 120;

const requestBody = z.object({
  /** Client-generated conversation id, so a refresh resumes the same thread. */
  id: z.string().uuid(),
  messages: z.array(z.unknown()).min(1),
});

export async function POST(request: Request): Promise<Response> {
  let parsed: z.infer<typeof requestBody>;
  try {
    parsed = requestBody.parse(await request.json());
  } catch (error) {
    return Response.json(
      { error: 'Invalid request body', detail: describe(error) },
      { status: 400 },
    );
  }

  const uiMessages = parsed.messages as UIMessage[];
  const lastUserMessage = [...uiMessages].reverse().find((message) => message.role === 'user');
  const userText = textOf(lastUserMessage);

  let user;
  let conversation;
  try {
    user = await resolveCurrentUser();
    conversation = await ensureConversation(user.id, parsed.id);
  } catch (error) {
    console.error('[chat] could not resolve request identity', error);
    return Response.json({ error: describe(error) }, { status: 500 });
  }

  const context = { user, conversationId: conversation.id };

  // Recall against the incoming message so the prompt carries the memories that
  // are relevant to *this* turn, not just the globally important ones.
  const [memories, taskSummaries] = await Promise.all([
    recall({ userId: user.id, query: userText, limit: 14 }),
    openTaskSummaries(user.id),
  ]);

  // With no lexical hits, fall back to the highest-signal memories so a new
  // topic still arrives with the standing context about who the user is.
  const contextMemories =
    memories.length > 0 ? memories : await recall({ userId: user.id, limit: 8 });

  const result = streamText({
    model: agentModel(),
    system: buildSystemPrompt({
      user,
      memories: contextMemories,
      now: new Date(),
      openTaskSummaries: taskSummaries,
    }),
    messages: await convertToModelMessages(uiMessages),
    tools: buildTools(context),
    // A tool-using agent needs room to look things up, act, and verify, but an
    // unbounded loop is a runaway bill. This bounds the turn, and the model is
    // told nothing about it, so it paces itself normally.
    stopWhen: stepCountIs(env.maxAgentSteps),
    providerOptions: agentProviderOptions(),
    onError: ({ error }) => {
      console.error('[chat] stream error', error);
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: uiMessages,
    sendReasoning: true,
    onFinish: async ({ messages, isAborted }) => {
      try {
        await saveMessages(conversation.id, messages);
      } catch (error) {
        console.error('[chat] failed to persist messages', error);
      }

      // An aborted turn has no settled assistant answer, so there is nothing
      // worth mining for memory and no title to derive.
      if (isAborted) return;

      const assistantText = textOf([...messages].reverse().find((m) => m.role === 'assistant'));

      await Promise.allSettled([
        maybeTitleConversation(conversation, userText),
        extractAndStoreMemories({
          userId: user.id,
          conversationId: conversation.id,
          userText,
          assistantText,
        }),
      ]);
    },
    onError: (error) => {
      // This string reaches the browser, so it must not leak internals.
      console.error('[chat] stream failed', error);
      return 'Something went wrong while answering. The details are in the server log.';
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
