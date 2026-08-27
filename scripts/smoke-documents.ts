/**
 * Document subsystem checks against a real database and real files.
 *
 * Parsing and path sandboxing are both areas where a mocked test proves very
 * little: PDF and DOCX extraction only works or fails on actual bytes, and a
 * symlink escape only reproduces on a real filesystem.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/smoke-documents.ts
 */

import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { sql as client, db } from '@/lib/db';
import { documentChunks, users } from '@/lib/db/schema';
import { resolveCurrentUser } from '@/lib/db/users';
import { chunkText } from '@/lib/documents/chunk';
import { detectKind, parseDocument, stripHtml } from '@/lib/documents/parse';
import {
  countChunks,
  deleteDocument,
  findDocumentsByName,
  getChunks,
  ingestDocument,
  listDocuments,
  searchDocuments,
} from '@/lib/documents/store';
import { FileAccessError, isWithin, listLocalFiles, readLocalFile } from '@/lib/documents/local-files';

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`, detail === undefined ? '' : detail);
  }
}

async function expectRejection(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    failures += 1;
    console.error(`  FAIL ${label} — expected a rejection, got`, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ok   ${label} (${message.slice(0, 70)})`);
  }
}

const fixture = (name: string) => join(process.cwd(), 'scripts', 'fixtures', name);
const bytesOf = async (name: string) => new Uint8Array(await readFile(fixture(name)));

async function main(): Promise<void> {
  await db.delete(users);
  const user = await resolveCurrentUser();

  console.log('kind detection');
  check('extension wins over a generic mime type', detectKind('notes.md', 'application/octet-stream') === 'markdown');
  check('mime type is used when the extension is unknown', detectKind('download', 'application/pdf') === 'pdf');
  check('unrecognised falls through', detectKind('mystery', '') === 'unknown');

  console.log('\nparsing');
  const md = await parseDocument('notes.md', await bytesOf('notes.md'));
  check('markdown parses', md.text.includes('LX-88213'), md.text.slice(0, 60));

  const csv = await parseDocument('expenses.csv', await bytesOf('expenses.csv'));
  check('csv reports its columns', JSON.stringify(csv.metadata.columns) === '["date","vendor","amount","category"]', csv.metadata);
  check('csv row count excludes the header', csv.metadata.rows === 3, csv.metadata.rows);
  check('csv repeats the header into each row', csv.text.includes('vendor: Rail Europe'), csv.text);
  check('csv handles a quoted comma', csv.text.includes('Cafe, Central'), csv.text);
  check('csv handles an escaped quote', csv.text.includes('He said "hello"'), csv.text);

  const json = await parseDocument('config.json', await bytesOf('config.json'));
  check('json is re-serialised with indentation', json.text.includes('\n  "service"'), json.text);

  const html = await parseDocument('article.html', await bytesOf('article.html'));
  check('html keeps the title', html.metadata.title === 'Reading list', html.metadata);
  check('html drops script content', !html.text.includes('alert(1)'), html.text);
  check('html drops style content', !html.text.includes('color:red'), html.text);
  check('html decodes entities', html.text.includes('Reading list'), html.text);
  check('html renders list items', html.text.includes('- Chapter 3'), html.text);

  const pdf = await parseDocument('quarterly-notes.pdf', await bytesOf('quarterly-notes.pdf'));
  check('pdf extracts text', pdf.text.includes('March 14th'), pdf.text.slice(0, 120));
  check('pdf reports its page count', pdf.metadata.pages === 1, pdf.metadata);

  const docx = await parseDocument('onboarding.docx', await bytesOf('onboarding.docx'));
  check('docx extracts text', docx.text.includes('VPN access'), docx.text.slice(0, 120));

  const binaryBytes = await bytesOf('binary.bin');
  await expectRejection('a binary file is rejected, not stored as noise', () =>
    parseDocument('binary.bin', binaryBytes),
  );

  await expectRejection('invalid json is rejected', () =>
    parseDocument('broken.json', new TextEncoder().encode('{"a": ')),
  );

  // JSON Lines is common enough that the parser retries as JSONL.
  const jsonl = await parseDocument('events.json', new TextEncoder().encode('{"a":1}\n{"a":2}\n'));
  check('json lines is accepted', jsonl.metadata.records === 2, jsonl.metadata);

  console.log('\nhtml stripping edge cases');
  check('numeric entities decode', stripHtml('<p>&#8212;dash</p>').text.includes('—'));
  check('an out-of-range entity is dropped, not thrown', stripHtml('<p>&#999999999;x</p>').text.includes('x'));
  check('unclosed tags do not hang', stripHtml('<div><p>text').text.includes('text'));

  console.log('\nchunking');
  const short = chunkText('One short paragraph.');
  check('short text is a single chunk', short.length === 1 && short[0]?.charOffset === 0, short);
  check('empty text produces no chunks', chunkText('   ').length === 0);

  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with enough words in it to take up real space in the document.`).join('\n\n');
  const chunks = chunkText(paragraphs, { size: 600, overlap: 100 });
  check('long text splits into several chunks', chunks.length > 3, chunks.length);
  check('ordinals are sequential from zero', chunks.every((chunk, i) => chunk.ordinal === i), chunks.map((c) => c.ordinal));
  check('offsets increase', chunks.every((chunk, i) => i === 0 || chunk.charOffset > (chunks[i - 1]?.charOffset ?? -1)));
  check(
    'chunks respect the size budget',
    chunks.every((chunk) => chunk.content.length <= 700),
    chunks.map((c) => c.content.length),
  );
  // Overlap means later chunks start mid-document, but never mid-word: the
  // character before a chunk's offset must be whitespace.
  check(
    'chunks begin at a word boundary',
    chunks.every((chunk) => chunk.charOffset === 0 || /\s/.test(paragraphs[chunk.charOffset - 1] ?? '')),
    chunks.map((c) => `${c.charOffset}:${JSON.stringify(c.content.slice(0, 14))}`),
  );
  check(
    'chunks end at a word boundary',
    chunks.every((chunk, i) => i === chunks.length - 1 || /[.\w"')\]]$/.test(chunk.content)),
    chunks.map((c) => JSON.stringify(c.content.slice(-14))),
  );
  // Overlap must actually overlap, or a fact spanning a boundary is lost.
  check(
    'consecutive chunks overlap',
    chunks.slice(1).every((chunk, i) => {
      const previous = chunks[i];
      return previous !== undefined && chunk.charOffset < previous.charOffset + previous.content.length;
    }),
  );

  // A single token longer than the chunk size must terminate, not spin.
  const unbroken = chunkText('x'.repeat(5000), { size: 400, overlap: 100 });
  check('an unbreakable run still terminates', unbroken.length > 0 && unbroken.length < 40, unbroken.length);

  console.log('\ningest and search');
  const ingested = await ingestDocument({
    userId: user.id,
    name: 'quarterly-notes.pdf',
    bytes: await bytesOf('quarterly-notes.pdf'),
    mimeType: 'application/pdf',
  });
  check('ingest stores the document', ingested.document.kind === 'pdf', ingested.document.kind);
  check('ingest writes chunks', ingested.chunks >= 1, ingested.chunks);
  check('first ingest is not a replacement', ingested.replaced === false);

  const reIngested = await ingestDocument({
    userId: user.id,
    name: 'quarterly-notes-renamed.pdf',
    bytes: await bytesOf('quarterly-notes.pdf'),
    mimeType: 'application/pdf',
  });
  check('re-ingesting identical bytes replaces rather than duplicates', reIngested.replaced === true);
  check('the same row is reused', reIngested.document.id === ingested.document.id);
  check('the name is updated on replace', reIngested.document.name === 'quarterly-notes-renamed.pdf');
  check('only one document exists', (await listDocuments(user.id)).length === 1);

  const chunkRows = await db.select().from(documentChunks).where(eq(documentChunks.userId, user.id));
  check('chunks are rebuilt, not accumulated', chunkRows.length === reIngested.chunks, chunkRows.length);

  for (const name of ['notes.md', 'expenses.csv', 'article.html', 'onboarding.docx']) {
    await ingestDocument({ userId: user.id, name, bytes: await bytesOf(name) });
  }
  check('all fixtures ingest', (await listDocuments(user.id)).length === 5);

  const deadlineHits = await searchDocuments({ userId: user.id, query: 'migration deadline March' });
  check('search finds the pdf passage', deadlineHits.some((hit) => hit.documentName.includes('quarterly')), deadlineHits);
  check('search returns a highlighted excerpt', deadlineHits[0]?.excerpt.includes('<<') === true, deadlineHits[0]?.excerpt);
  check('search relevance is bounded', deadlineHits.every((hit) => hit.relevance >= 0 && hit.relevance <= 1));

  const vpnHits = await searchDocuments({ userId: user.id, query: 'VPN keycards security' });
  check('search finds the docx passage', vpnHits.some((hit) => hit.documentName === 'onboarding.docx'), vpnHits);

  const scopedHits = await searchDocuments({
    userId: user.id,
    query: 'Lisbon October hotel',
    documentIds: [ingested.document.id],
  });
  check('document_ids scopes the search', scopedHits.length === 0, scopedHits);

  check('an all-stopword query returns nothing rather than everything', (await searchDocuments({ userId: user.id, query: 'the and of' })).length === 0);
  check('operator characters cannot break the query', Array.isArray(await searchDocuments({ userId: user.id, query: 'a & | ! ( :* "x' })));

  const named = await findDocumentsByName(user.id, 'expense');
  check('name search works', named.length === 1 && named[0]?.name === 'expenses.csv', named.map((d) => d.name));

  console.log('\nreading windows');
  const total = await countChunks(user.id, ingested.document.id);
  check('chunk count is reported', total === reIngested.chunks, { total, expected: reIngested.chunks });

  const window = await getChunks(user.id, ingested.document.id, 0, 2);
  check('a window reads from the requested ordinal', window[0]?.ordinal === 0, window.map((c) => c.ordinal));

  const pastEnd = await getChunks(user.id, ingested.document.id, 9999, 2);
  check('reading past the end returns nothing rather than throwing', pastEnd.length === 0);

  console.log('\ntenant isolation');
  const [other] = await db.insert(users).values({ email: 'other@example.com' }).returning();
  if (!other) throw new Error('expected a second user');
  check("another user cannot read someone's document chunks", (await getChunks(other.id, ingested.document.id, 0, 5)).length === 0);
  check("another user's search sees nothing", (await searchDocuments({ userId: other.id, query: 'migration deadline' })).length === 0);
  check("another user cannot delete it", (await deleteDocument(other.id, ingested.document.id)) === false);
  check('the owner can delete it', (await deleteDocument(user.id, ingested.document.id)) === true);
  check('deleting a document cascades its chunks', (await countChunks(user.id, ingested.document.id)) === 0);

  console.log('\nlocal file sandbox');
  const root = await mkdtemp(join(tmpdir(), 'agent-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-secret-'));

  await writeFile(join(root, 'diary.md'), '# Diary\n\nThe dentist appointment moved to Thursday.\n');
  await mkdir(join(root, 'work'), { recursive: true });
  await writeFile(join(root, 'work', 'plan.txt'), 'Ship the billing migration.\n');
  await writeFile(join(root, '.env'), 'SECRET=should-never-be-listed\n');
  await writeFile(join(outside, 'passwords.txt'), 'root:hunter2\n');
  await symlink(join(outside, 'passwords.txt'), join(root, 'innocent.txt'));
  await symlink(outside, join(root, 'shortcut'));

  process.env.AGENT_FILES_DIR = root;

  check('isWithin accepts a child', isWithin('/data', '/data/notes/a.txt'));
  check('isWithin accepts the root itself', isWithin('/data', '/data'));
  check('isWithin rejects a sibling with a shared prefix', !isWithin('/data', '/data-other/a.txt'));
  check('isWithin rejects a parent', !isWithin('/data/sub', '/data'));

  const listing = await listLocalFiles('.', { recursive: true });
  const listedPaths = listing.map((entry) => entry.path);
  check('listing finds a file', listedPaths.includes('diary.md'), listedPaths);
  check('listing recurses', listedPaths.includes(join('work', 'plan.txt')), listedPaths);
  check('listing hides dotfiles', !listedPaths.some((path) => path.includes('.env')), listedPaths);

  const read = await readLocalFile('diary.md');
  check('a file inside the root reads', new TextDecoder().decode(read.bytes).includes('dentist'), read.path);
  check('the returned path is root-relative', read.path === 'diary.md', read.path);

  await expectRejection('relative traversal is refused', () => readLocalFile('../../etc/passwd'));
  await expectRejection('an absolute path outside the root is refused', () => readLocalFile('/etc/passwd'));
  await expectRejection('a symlink to a file outside the root is refused', () => readLocalFile('innocent.txt'));
  await expectRejection('a symlink to a directory outside the root is refused', () => readLocalFile(join('shortcut', 'passwords.txt')));
  await expectRejection('a NUL byte in the path is refused', () => readLocalFile('diary.md\u0000/etc/passwd'));
  await expectRejection('a directory is not readable as a file', () => readLocalFile('work'));
  await expectRejection('a missing file reports not found', () => readLocalFile('nope.txt'));

  // An absolute path that happens to be inside the root is legitimate.
  const absolute = await readLocalFile(join(root, 'work', 'plan.txt'));
  check('an absolute path inside the root is allowed', absolute.path === join('work', 'plan.txt'), absolute.path);

  delete process.env.AGENT_FILES_DIR;
  await expectRejection('file access is off when unconfigured', () => readLocalFile('diary.md'));

  const errorType = await readLocalFile('x').catch((error: unknown) => error);
  check('refusals use FileAccessError', errorType instanceof FileAccessError, errorType);

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nsmoke run crashed', error);
  await client.end();
  process.exit(1);
});
