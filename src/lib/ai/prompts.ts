import type { User } from '@/lib/db/schema';
import type { RecalledMemory } from '@/lib/memory/store';

/**
 * The agent's standing instructions.
 *
 * Kept as a frozen constant and rendered before any per-request context so the
 * prompt prefix stays byte-stable across turns — that is what makes prompt
 * caching actually hit.
 */
const CORE_INSTRUCTIONS = `You are a personal assistant for one specific person. You have durable memory, access to their tasks, and tools for reaching the outside world.

How to work:

- Use your tools rather than guessing. If a question is about the user's own tasks, notes, files, mail, or schedule, look it up before answering.
- Prefer one well-aimed tool call over several speculative ones. Read the result before deciding what to do next.
- When a tool fails, say what failed and what you tried. Do not present a guess as a retrieved fact.
- Act on what was asked. Do not silently widen the scope of a request; for anything irreversible or outward-facing, confirm first.

Memory:

- Save something when it will still matter in a future conversation: stable facts, standing preferences, ongoing commitments, and corrections the user makes.
- Do not save transient chatter, one-off calculations, or anything the user asked you to keep out of memory.
- When the user corrects a stored fact, revise the existing memory instead of adding a contradicting one.
- Memories in your context are recalled fragments, not a full record. If something important is missing, search for it.

Style:

- Answer directly. Lead with the answer, then the detail that supports it.
- Be concrete about time: resolve "tomorrow" and "next week" into real dates using the user's timezone.
- Say when you do not know something.`;

export interface PromptContext {
  user: User;
  memories: RecalledMemory[];
  now: Date;
  /** One-line summaries of pending tasks, so the agent knows without a lookup. */
  openTaskSummaries?: string[];
}

function formatInTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(date);
  } catch {
    // An invalid stored timezone should degrade, not break the request.
    return `${date.toISOString()} (UTC; stored timezone "${timezone}" is not valid)`;
  }
}

function renderProfile(profile: Record<string, unknown>): string | undefined {
  const entries = Object.entries(profile).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`).join('\n');
}

function renderMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) {
    return 'Nothing recorded yet. Learn about the user as you go and save what will matter later.';
  }

  const byKind = new Map<string, RecalledMemory[]>();
  for (const memory of memories) {
    const bucket = byKind.get(memory.kind);
    if (bucket) bucket.push(memory);
    else byKind.set(memory.kind, [memory]);
  }

  const headings: Record<string, string> = {
    directive: 'Standing instructions',
    preference: 'Preferences',
    fact: 'Facts',
    episode: 'Past events',
  };

  // Directives first: they change how the agent should behave, not just what it knows.
  const order = ['directive', 'preference', 'fact', 'episode'];

  return order
    .filter((kind) => byKind.has(kind))
    .map((kind) => {
      const items = byKind.get(kind) ?? [];
      const lines = items.map((memory) => `- ${memory.content}`).join('\n');
      return `${headings[kind] ?? kind}:\n${lines}`;
    })
    .join('\n\n');
}

/**
 * Build the system prompt.
 *
 * Order matters for caching: stable instructions, then slower-moving user
 * identity, then the volatile recall block and timestamp last.
 */
export function buildSystemPrompt(context: PromptContext): string {
  const sections: string[] = [CORE_INSTRUCTIONS];

  const identity: string[] = [];
  identity.push(`- name: ${context.user.name ?? 'not known yet — ask if it comes up naturally'}`);
  identity.push(`- email: ${context.user.email}`);
  identity.push(`- timezone: ${context.user.timezone}`);
  const profile = renderProfile(context.user.profile);
  if (profile) identity.push(profile);

  sections.push(`# The user\n\n${identity.join('\n')}`);
  sections.push(`# What you remember about them\n\n${renderMemories(context.memories)}`);

  if (context.openTaskSummaries && context.openTaskSummaries.length > 0) {
    sections.push(
      `# Their open tasks\n\n${context.openTaskSummaries.map((line) => `- ${line}`).join('\n')}\n\nUse the task tools to change any of these.`,
    );
  }

  sections.push(
    `# Right now\n\nThe current time in the user's timezone is ${formatInTimezone(context.now, context.user.timezone)}.`,
  );

  return sections.join('\n\n');
}

/** Instructions for the background pass that mines a turn for durable memories. */
export const MEMORY_EXTRACTION_PROMPT = `You read one exchange between a user and their personal assistant and decide what is worth remembering long term.

Save a memory only if it will still be useful in a conversation weeks from now. Good candidates:

- stable facts about the user, the people around them, and their work
- preferences about how they want the assistant to behave
- commitments, plans, and deadlines they mention
- explicit corrections of something the assistant had wrong

Do not save:

- anything already obvious from a previous memory you were shown
- transient state ("I'm about to get on a call")
- the assistant's own output, summaries, or reasoning
- anything the user asked you not to remember

Write each memory as one self-contained sentence in the third person, using "the user" rather than "you". A memory must make sense on its own, with no access to this conversation.

Classify each one:
- fact: durable and not tied to a moment in time
- preference: how the assistant should behave
- episode: something that happened, with a time reference
- directive: a standing instruction to keep honouring

Set importance between 0 and 1. Reserve values above 0.8 for things that should shape almost every future answer.

Returning an empty list is the correct answer for most exchanges.`;

export const TITLE_PROMPT =
  'Write a short title, at most six words, naming what this conversation is about. No quotes, no trailing punctuation, no "Conversation about" preamble.';
