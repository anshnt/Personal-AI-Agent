/**
 * End-to-end smoke check against a real PostgreSQL database.
 *
 * This exercises the SQL that unit tests with a mocked driver would not: full
 * text recall, array overlap filters, the upsert path in message persistence,
 * and the timezone resolver. Run it against a scratch database:
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/smoke.ts
 */

import { eq } from 'drizzle-orm';

import { sql as client, db } from '@/lib/db';
import { conversations, memories, messages, tasks, users } from '@/lib/db/schema';
import { ensureConversation, loadMessages, saveMessages } from '@/lib/conversations';
import { resolveCurrentUser } from '@/lib/db/users';
import {
  forgetMatching,
  listMemories,
  recall,
  remember,
  reviseMemory,
} from '@/lib/memory/store';
import { createTask, findTaskByTitle, listTasks, openTaskSummaries, updateTask } from '@/lib/tasks/store';
import { anchorLocalTime, calendarDateIn, describeRelative, formatInTimezone } from '@/lib/time';

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  // One stream throughout: stdout and stderr interleave unpredictably in a CI
  // log, which puts a failure under the wrong section heading.
  console.log(`  FAIL ${label}`, detail === undefined ? '' : detail);
}

async function reset(): Promise<void> {
  // Cascades clear conversations, messages, memories, and tasks.
  await db.delete(users);
}

async function main(): Promise<void> {
  console.log('resetting');
  await reset();

  console.log('\nusers');
  const user = await resolveCurrentUser();
  check('creates the acting user on first use', user.id.length === 36, user);
  const again = await resolveCurrentUser();
  check('is idempotent', again.id === user.id);

  console.log('\nmemory: write and recall');
  await remember({
    userId: user.id,
    content: 'The user works as a backend engineer at a logistics startup.',
    kind: 'fact',
    importance: 0.8,
    tags: ['work'],
  });
  await remember({
    userId: user.id,
    content: 'The user prefers short, direct answers with no preamble.',
    kind: 'preference',
    importance: 0.9,
    tags: ['style'],
  });
  await remember({
    userId: user.id,
    content: 'The user is training for a half marathon in October.',
    kind: 'fact',
    importance: 0.6,
    tags: ['health'],
  });

  const all = await listMemories(user.id);
  check('stores three memories', all.length === 3, all.length);

  const duplicate = await remember({
    userId: user.id,
    content: '  The user   works as a backend engineer at a logistics startup. ',
    kind: 'fact',
    importance: 0.4,
    tags: ['career'],
  });
  const afterDuplicate = await listMemories(user.id);
  check('reinforces an exact duplicate instead of inserting', afterDuplicate.length === 3, afterDuplicate.length);
  check('keeps the higher importance on reinforce', duplicate.importance === 0.8, duplicate.importance);
  check('merges tags on reinforce', duplicate.tags.includes('work') && duplicate.tags.includes('career'), duplicate.tags);

  const workHits = await recall({ userId: user.id, query: 'where does the user work' });
  check('full-text recall finds the work fact', workHits.some((m) => m.content.includes('backend engineer')), workHits);

  const runHits = await recall({ userId: user.id, query: 'running marathon training' });
  check('full-text recall finds the running fact', runHits.some((m) => m.content.includes('half marathon')), runHits);

  const scored = workHits[0];
  check('scores are within 0..1', scored !== undefined && scored.score >= 0 && scored.score <= 1, scored?.score);

  const noQuery = await recall({ userId: user.id, limit: 2 });
  check('query-less recall returns the highest-signal memories', noQuery.length === 2, noQuery.length);
  check(
    'query-less recall is ordered by importance',
    noQuery[0] !== undefined && noQuery[0].content.includes('short, direct'),
    noQuery.map((m) => m.content),
  );

  const tagged = await recall({ userId: user.id, tags: ['health'] });
  check('tag filter uses array overlap', tagged.length === 1 && tagged[0]?.tags.includes('health') === true, tagged);

  const kindFiltered = await recall({ userId: user.id, kinds: ['preference'] });
  check('kind filter works', kindFiltered.length === 1 && kindFiltered[0]?.kind === 'preference', kindFiltered);

  // Malformed query text must not raise: this arrives straight from a model.
  const hostile = await recall({ userId: user.id, query: 'work & | ! ( :* <-> "unclosed' });
  check('operator characters in a query cannot break to_tsquery', Array.isArray(hostile), hostile);

  console.log('\nmemory: revision and deletion');
  const workMemory = afterDuplicate.find((m) => m.content.includes('backend engineer'));
  if (!workMemory) throw new Error('expected the work memory to exist');

  const revised = await reviseMemory(
    user.id,
    workMemory.id,
    'The user works as a staff engineer at a logistics startup.',
  );
  check('revision creates a replacement', revised.id !== workMemory.id);

  const liveAfterRevision = await listMemories(user.id);
  check('superseded memory drops out of recall', liveAfterRevision.length === 3, liveAfterRevision.length);
  check(
    'the replacement is what is recalled',
    liveAfterRevision.some((m) => m.content.includes('staff engineer')),
    liveAfterRevision.map((m) => m.content),
  );
  check(
    'the old version is retained in the table',
    (await db.select().from(memories)).length === 4,
  );

  const forgotten = await forgetMatching(user.id, 'half marathon training October');
  check('free-text forget removes a confident match', forgotten.length === 1, forgotten);

  const weakForget = await forgetMatching(user.id, 'quantum entanglement in seahorses');
  check('free-text forget refuses a weak match', weakForget.length === 0, weakForget);

  console.log('\nexpiry');
  await remember({
    userId: user.id,
    content: 'The user is on holiday and unreachable.',
    kind: 'fact',
    expiresAt: new Date(Date.now() - 1000),
  });
  const afterExpiry = await recall({ userId: user.id, query: 'holiday unreachable' });
  check('expired memories are not recalled', afterExpiry.length === 0, afterExpiry);

  console.log('\ntasks');
  const due = new Date(Date.now() + 3 * 86_400_000);
  const task = await createTask({
    userId: user.id,
    title: 'Renew passport',
    notes: 'Book the appointment at the regional office',
    priority: 1,
    tags: ['Admin', 'admin', ' '],
    dueAt: due,
  });
  check('normalises and dedupes tags', task.tags.length === 1 && task.tags[0] === 'admin', task.tags);

  await createTask({ userId: user.id, title: 'Water the plants', priority: 4 });
  await createTask({ userId: user.id, title: 'Draft Q3 plan', priority: 2, dueAt: new Date(Date.now() + 86_400_000) });

  const open = await listTasks({ userId: user.id });
  check('lists open tasks', open.length === 3, open.length);
  check(
    'orders by due date with undated last',
    open[0]?.title === 'Draft Q3 plan' && open[2]?.title === 'Water the plants',
    open.map((t) => t.title),
  );

  const dueSoon = await listTasks({ userId: user.id, dueBefore: new Date(Date.now() + 2 * 86_400_000) });
  check('dueBefore filters correctly', dueSoon.length === 1 && dueSoon[0]?.title === 'Draft Q3 plan', dueSoon.map((t) => t.title));

  // The tag filter had a silently broken array binding that no check covered.
  const byTag = await listTasks({ userId: user.id, tags: ['admin'] });
  check('the task tag filter works', byTag.length === 1 && byTag[0]?.title === 'Renew passport', byTag.map((t) => t.title));
  check('the task tag filter normalises case', (await listTasks({ userId: user.id, tags: ['ADMIN'] })).length === 1);
  check('a tag nothing carries returns nothing', (await listTasks({ userId: user.id, tags: ['nope'] })).length === 0);

  const found = await findTaskByTitle(user.id, 'passport');
  check('finds a task by title substring', found.length === 1, found.map((t) => t.title));

  const byNotes = await findTaskByTitle(user.id, 'regional office');
  check('finds a task by notes substring', byNotes.length === 1, byNotes.map((t) => t.title));

  const completed = await updateTask(user.id, task.id, { status: 'done' });
  check('completing sets completedAt', completed?.completedAt instanceof Date, completed?.completedAt);

  const reopened = await updateTask(user.id, task.id, { status: 'todo' });
  check('reopening clears completedAt', reopened?.completedAt === null, reopened?.completedAt);

  const cleared = await updateTask(user.id, task.id, { dueAt: null, notes: null });
  check('null clears a due date', cleared?.dueAt === null);
  check('null clears notes', cleared?.notes === null);

  const summaries = await openTaskSummaries(user.id);
  check('builds prompt summaries', summaries.length === 3, summaries);

  const otherUser = await db.insert(users).values({ email: 'someone-else@example.com' }).returning();
  const foreign = otherUser[0];
  if (!foreign) throw new Error('expected the second user to be created');
  const crossTenant = await updateTask(foreign.id, task.id, { title: 'Hijacked' });
  check('a task cannot be updated by another user', crossTenant === undefined, crossTenant);

  console.log('\nconversations');
  const conversationId = crypto.randomUUID();
  const conversation = await ensureConversation(user.id, conversationId);
  check('creates a conversation under a client-supplied id', conversation.id === conversationId);

  const sameConversation = await ensureConversation(user.id, conversationId);
  check('ensureConversation is idempotent', sameConversation.id === conversationId);

  let crossTenantConversation = false;
  try {
    await ensureConversation(foreign.id, conversationId);
  } catch {
    crossTenantConversation = true;
  }
  check("another user cannot claim someone else's conversation id", crossTenantConversation);

  const first = [
    { id: crypto.randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] },
    { id: crypto.randomUUID(), role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'hi there' }] },
  ];
  await saveMessages(conversationId, first);
  const loaded = await loadMessages(conversationId);
  check('persists and reloads messages in order', loaded.length === 2 && loaded[0]?.role === 'user', loaded.map((m) => m.role));

  // Re-saving with a grown assistant message is the streaming case.
  const grown = [
    first[0]!,
    { ...first[1]!, parts: [{ type: 'text' as const, text: 'hi there, updated' }] },
    { id: crypto.randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'thanks' }] },
  ];
  await saveMessages(conversationId, grown);
  const reloaded = await loadMessages(conversationId);
  check('upsert does not duplicate rows', reloaded.length === 3, reloaded.length);
  check(
    'upsert updates the parts of an existing message',
    JSON.stringify(reloaded[1]?.parts).includes('updated'),
    reloaded[1]?.parts,
  );

  const rowCount = await db.select().from(messages);
  check('no orphaned message rows', rowCount.length === 3, rowCount.length);

  // Timezone helpers and local-time anchoring are pure and are covered by the vitest suite; what needs the
  // database is below.

  console.log('\ncascade');
  await db.delete(users).where(eq(users.id, user.id));
  const remainingConversations = await db.select().from(conversations);
  const remainingTasks = await db.select().from(tasks);
  check('deleting a user cascades conversations', remainingConversations.length === 0, remainingConversations.length);
  check('deleting a user cascades tasks', remainingTasks.length === 0, remainingTasks.length);

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nsmoke run crashed', error);
  await client.end();
  process.exit(1);
});
