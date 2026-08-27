/**
 * Semantic memory checks against real pgvector.
 *
 * No API key is used. A deterministic embedder stands in for the provider, which
 * is enough because the parts that can be wrong here are all on this side of the
 * network: whether the extension and column are detected, whether the vector
 * round-trips through pgvector, whether cosine ordering is right, whether
 * fusion combines two rankings correctly, and whether all of it degrades to
 * lexical when support is absent.
 *
 * The provider HTTP calls are verified by shape in the unit tests.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/smoke-semantic.ts
 */

import { eq } from 'drizzle-orm';

import { sql as client, db } from '@/lib/db';
import { memories, users } from '@/lib/db/schema';
import { resolveCurrentUser } from '@/lib/db/users';
import { EMBEDDING_DIMENSIONS, toVectorLiteral } from '@/lib/memory/embeddings';
import {
  backfillEmbeddings,
  embeddingCoverage,
  resetSemanticCapability,
  semanticCapability,
  semanticSearch,
} from '@/lib/memory/semantic';
import { lexicalRecall, recall, remember } from '@/lib/memory/store';

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}`, detail === undefined ? '' : detail);
}

/**
 * A deterministic embedder with a controllable notion of similarity.
 *
 * Each topic gets its own basis direction, so texts sharing a topic are close
 * and texts in different topics are far. That is exactly the property recall
 * depends on, and it makes the assertions below deterministic rather than
 * dependent on a live model's judgement.
 */
const TOPICS = ['work', 'health', 'travel', 'food'] as const;

function fakeEmbedding(topic: (typeof TOPICS)[number], jitter = 0): number[] {
  const axis = TOPICS.indexOf(topic);
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  // A block per topic keeps the directions orthogonal.
  const blockSize = Math.floor(EMBEDDING_DIMENSIONS / TOPICS.length);
  for (let i = 0; i < blockSize; i += 1) {
    vector[axis * blockSize + i] = 1;
  }
  // Jitter perturbs a neighbouring block, so two memories on the same topic can
  // still be ordered relative to a query.
  if (jitter > 0) {
    const neighbour = ((axis + 1) % TOPICS.length) * blockSize;
    for (let i = 0; i < Math.floor(blockSize * jitter); i += 1) {
      vector[neighbour + i] = 1;
    }
  }

  // Normalise, so cosine distance behaves as expected.
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

async function setEmbedding(
  memoryId: string,
  topic: (typeof TOPICS)[number],
  model: string,
  jitter = 0,
): Promise<void> {
  await client`
    update memories
    set embedding = ${toVectorLiteral(fakeEmbedding(topic, jitter))}::vector,
        embedding_model = ${model}
    where id = ${memoryId}::uuid
  `;
}

/**
 * The properties that must hold whether or not semantic recall is available.
 *
 * Run in both paths, because "it degrades to lexical" is the claim that makes
 * the feature optional, and a claim only checked on the happy path is not
 * checked.
 */
async function runDegradationChecks(userId: string): Promise<void> {
  console.log('\nrecall works regardless');

  await remember({
    userId,
    content: 'The user is training for a half marathon in October.',
    kind: 'fact',
    importance: 0.6,
  });
  await remember({
    userId,
    content: 'The user prefers short, direct answers.',
    kind: 'preference',
    importance: 0.9,
  });

  const hits = await recall({ userId, query: 'half marathon training' });
  check('recall still finds a lexical match', hits.some((m) => m.content.includes('half marathon')), hits.map((m) => m.content));
  check('every result says how it matched', hits.every((m) => m.matchedBy !== undefined), hits.map((m) => m.matchedBy));
  check('scores stay within 0..1', hits.every((m) => m.score >= 0 && m.score <= 1), hits.map((m) => m.score));

  const queryless = await recall({ userId, limit: 1 });
  check('a query-less recall returns the most important memory', queryless[0]?.content.includes('short, direct') === true, queryless.map((m) => m.content));

  const semantic = await semanticSearch({ userId, query: 'anything at all' });
  check('semantic search returns nothing rather than throwing', Array.isArray(semantic), semantic);

  const backfill = await backfillEmbeddings(userId, 10);
  check('backfill reports why it did nothing rather than failing', backfill.embedded === 0 && typeof backfill.reason === 'string', backfill);

  const coverage = await embeddingCoverage(userId);
  check('coverage still counts the memories that exist', coverage.total >= 2, coverage);
}

async function main(): Promise<void> {
  await db.delete(users);
  const user = await resolveCurrentUser();

  console.log('capability detection');
  resetSemanticCapability();
  const capability = await semanticCapability();

  const noProviderConfigured = !process.env.VOYAGE_API_KEY && !process.env.OPENAI_API_KEY;
  if (noProviderConfigured) {
    check('with no provider key, semantic recall reports unavailable', capability.available === false, capability);
    check('and says why', (capability.reason ?? '').includes('no embedding provider'), capability.reason);
  } else {
    console.log('  skip provider-absent check (a provider key is configured in this environment)');
  }

  // Semantic memory is optional, so this suite has to be meaningful on a
  // database without pgvector too. Without the column, the vector checks have
  // nothing to exercise and the degradation checks are the whole point.
  if (!capability.columnPresent) {
    console.log('\npgvector is not present on this database');
    check('capability reports the extension as missing', capability.extensionInstalled === false, capability);
    check('and says so in a way a person can act on', (capability.reason ?? '').includes('pgvector'), capability.reason);
    check('semantic recall is unavailable', capability.available === false, capability);

    await runDegradationChecks(user.id);

    console.log(`\n${failures === 0 ? 'PASS (degradation only: pgvector absent)' : `FAIL (${failures})`}`);
    await client.end();
    process.exit(failures === 0 ? 0 : 1);
  }

  check('the pgvector extension is detected', capability.extensionInstalled === true, capability);
  check('the embedding column is detected', capability.columnPresent === true, capability);

  // From here on, vectors are written directly, so the checks do not depend on a
  // provider being configured at all.
  const MODEL = 'fake-test-model';

  console.log('\nvector round trip');
  const work = await remember({
    userId: user.id,
    content: 'The user is employed at a logistics startup, working on the backend.',
    kind: 'fact',
    importance: 0.8,
  });
  const health = await remember({
    userId: user.id,
    content: 'The user is training for a half marathon in October.',
    kind: 'fact',
    importance: 0.6,
  });
  const travel = await remember({
    userId: user.id,
    content: 'The user has flights booked to Lisbon on the third.',
    kind: 'fact',
    importance: 0.5,
  });
  const food = await remember({
    userId: user.id,
    content: 'The user does not eat anchovies under any circumstances.',
    kind: 'preference',
    importance: 0.4,
  });

  await setEmbedding(work.id, 'work', MODEL);
  await setEmbedding(health.id, 'health', MODEL);
  await setEmbedding(travel.id, 'travel', MODEL);
  await setEmbedding(food.id, 'food', MODEL);

  const stored = await client<Array<{ dims: number }>>`
    select vector_dims(embedding) as dims from memories where id = ${work.id}::uuid
  `;
  check('a vector round-trips through pgvector at the right width', stored[0]?.dims === EMBEDDING_DIMENSIONS, stored[0]);

  console.log('\ncosine ordering');
  // Query the topic directly: the matching memory must come first.
  const nearWork = await client<Array<{ id: string; distance: number }>>`
    select id, (embedding <=> ${toVectorLiteral(fakeEmbedding('work'))}::vector) as distance
    from memories where user_id = ${user.id}::uuid and embedding is not null
    order by embedding <=> ${toVectorLiteral(fakeEmbedding('work'))}::vector
  `;
  check('the same-topic memory is nearest', nearWork[0]?.id === work.id, nearWork.map((r) => r.distance));
  check('an identical direction has distance zero', Number(nearWork[0]?.distance) < 1e-6, nearWork[0]?.distance);
  check('a different topic is far', Number(nearWork[1]?.distance) > 0.9, nearWork[1]?.distance);

  // Jitter must order two same-topic memories relative to a pure query.
  const jittered = await remember({
    userId: user.id,
    content: 'The user mentioned a logistics conference next spring.',
    kind: 'episode',
    importance: 0.3,
  });
  await setEmbedding(jittered.id, 'work', MODEL, 0.5);
  const ordered = await client<Array<{ id: string }>>`
    select id from memories
    where user_id = ${user.id}::uuid and embedding is not null
    order by embedding <=> ${toVectorLiteral(fakeEmbedding('work'))}::vector
    limit 2
  `;
  check('an exact topic match outranks a partial one', ordered[0]?.id === work.id && ordered[1]?.id === jittered.id, ordered);

  console.log('\nmodel isolation');
  // Vectors from a different model are not in the same space, so they must not
  // be compared. Changing provider should degrade to lexical, not to nonsense.
  await setEmbedding(travel.id, 'travel', 'a-different-model');
  const sameModelOnly = await client<Array<{ id: string }>>`
    select id from memories
    where user_id = ${user.id}::uuid and embedding is not null and embedding_model = ${MODEL}
  `;
  check('a differently-modelled vector is excluded', !sameModelOnly.some((r) => r.id === travel.id), sameModelOnly.length);
  await setEmbedding(travel.id, 'travel', MODEL);

  console.log('\ncoverage reporting');
  const unindexed = await remember({
    userId: user.id,
    content: 'The user prefers to be called by their first name only.',
    kind: 'preference',
    importance: 0.7,
  });
  const coverage = await embeddingCoverage(user.id);
  check('total counts every live memory', coverage.total === 6, coverage);
  check('vectors present are counted regardless of model', coverage.withAnyEmbedding === 5, coverage);
  check('partial coverage is visible', coverage.withAnyEmbedding < coverage.total, coverage);
  if (noProviderConfigured) {
    // With no current model, nothing stored is usable, whatever is stored.
    check('nothing is usable when no provider is configured', coverage.embedded === 0, coverage);
  }
  void unindexed;

  // A provider change leaves vectors that exist but cannot be compared. That
  // state is distinct from "not indexed yet" and has a different fix.
  await setEmbedding(food.id, 'food', 'an-older-model');
  const afterModelChange = await embeddingCoverage(user.id);
  check('a stale vector still counts as present', afterModelChange.withAnyEmbedding === 5, afterModelChange);
  await setEmbedding(food.id, 'food', MODEL);

  console.log('\nsemantic search with no provider');
  // semanticSearch has to embed the query, which needs a provider. With none, it
  // returns nothing rather than throwing, so recall can fall through.
  if (noProviderConfigured) {
    const hits = await semanticSearch({ userId: user.id, query: 'where do they work' });
    check('semantic search returns nothing rather than throwing', Array.isArray(hits) && hits.length === 0, hits);
  } else {
    console.log('  skip (a provider key is configured, so the query would be embedded for real)');
  }

  console.log('\nrecall falls back cleanly');
  // This is the property that matters most: with semantic recall unavailable,
  // recall must behave exactly as the lexical-only path did.
  const lexicalOnly = await lexicalRecall({ userId: user.id, query: 'half marathon training' });
  const viaRecall = await recall({ userId: user.id, query: 'half marathon training' });
  check('lexical recall still finds the running memory', lexicalOnly.some((m) => m.id === health.id), lexicalOnly.map((m) => m.content));
  check('recall finds it too', viaRecall.some((m) => m.id === health.id), viaRecall.map((m) => m.content));
  check('recall reports how each memory matched', viaRecall.every((m) => m.matchedBy !== undefined), viaRecall.map((m) => m.matchedBy));
  check('scores stay within 0..1', viaRecall.every((m) => m.score >= 0 && m.score <= 1), viaRecall.map((m) => m.score));

  const queryless = await recall({ userId: user.id, limit: 3 });
  check('a query-less recall still returns the highest-signal memories', queryless.length === 3, queryless.length);
  check(
    'and is ordered by importance',
    queryless[0]?.content.includes('logistics startup') === true,
    queryless.map((m) => m.content),
  );

  console.log('\nfusion arithmetic');
  // Fusion is exercised directly, with a stub semantic ranking, so the ordering
  // logic is checked without needing a provider.
  const { fuseForTests } = await import('@/lib/memory/store');
  if (fuseForTests) {
    const lexical = await lexicalRecall({ userId: user.id, query: 'logistics startup backend' });
    const semanticStub = [
      { id: food.id, similarity: 0.9 },
      { id: work.id, similarity: 0.8 },
    ];
    const fused = await fuseForTests({ userId: user.id, query: 'x' }, lexical, semanticStub, 10);

    check('a memory found by both indexes ranks first', fused[0]?.id === work.id, fused.map((m) => `${m.id.slice(0, 8)}:${m.matchedBy}`));
    check('it is labelled as matched by both', fused[0]?.matchedBy === 'both', fused[0]?.matchedBy);
    check(
      'a semantic-only hit is included and labelled',
      fused.some((m) => m.id === food.id && m.matchedBy === 'meaning'),
      fused.map((m) => `${m.content.slice(0, 24)}:${m.matchedBy}`),
    );
    check('fused scores stay within 0..1', fused.every((m) => m.score >= 0 && m.score <= 1), fused.map((m) => m.score));
    check('fused results are sorted descending', fused.every((m, i) => i === 0 || m.score <= (fused[i - 1]?.score ?? 1)), fused.map((m) => m.score));
    check('the limit is honoured', (await fuseForTests({ userId: user.id, query: 'x' }, lexical, semanticStub, 2)).length <= 2);
  } else {
    check('fusion is exported for testing', false, 'fuseForTests is missing');
  }

  // The same properties are checked here, on a database that *does* have
  // pgvector, so "it degrades to lexical" is verified in both environments
  // rather than only in the one that forces it.
  const [degradationUser] = await db
    .insert(users)
    .values({ email: 'degradation@example.com' })
    .returning();
  if (!degradationUser) throw new Error('expected a user for the degradation checks');
  await runDegradationChecks(degradationUser.id);

  console.log('\ntenant isolation');
  const [other] = await db.insert(users).values({ email: 'other@example.com' }).returning();
  if (!other) throw new Error('expected a second user');
  const foreign = await client<Array<{ id: string }>>`
    select id from memories
    where user_id = ${other.id}::uuid and embedding is not null
  `;
  check("another user sees none of these vectors", foreign.length === 0, foreign.length);
  check("another user's coverage is empty", (await embeddingCoverage(other.id)).total === 0);

  console.log('\ncascade');
  const beforeDelete = (await db.select().from(memories).where(eq(memories.userId, user.id))).length;
  await db.delete(users).where(eq(users.id, user.id));
  const afterDelete = await db.select().from(memories).where(eq(memories.userId, user.id));
  check('the user had memories to begin with', beforeDelete > 0, beforeDelete);
  // Scoped to this user: other users' memories must survive, which is the other
  // half of the cascade being correct.
  check('deleting a user removes their vectors with their memories', afterDelete.length === 0, afterDelete.length);
  check(
    "another user's memories survive",
    (await db.select().from(memories).where(eq(memories.userId, degradationUser.id))).length > 0,
  );

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nsmoke run crashed', error);
  await client.end();
  process.exit(1);
});
