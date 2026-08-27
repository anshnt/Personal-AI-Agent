import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectKind, parseCsv, parseDocument, stripHtml } from './parse';

/**
 * Format parsing, against real bytes.
 *
 * PDF and DOCX extraction only genuinely works or fails on actual files, so the
 * fixtures in scripts/fixtures are used here rather than hand-built strings.
 */

const fixture = (name: string) => join(process.cwd(), 'scripts', 'fixtures', name);
const bytesOf = async (name: string) => new Uint8Array(await readFile(fixture(name)));
const encode = (text: string) => new TextEncoder().encode(text);

describe('detectKind', () => {
  it('prefers the extension over a generic mime type', () => {
    // Browsers report application/octet-stream for plenty of ordinary files.
    expect(detectKind('notes.md', 'application/octet-stream')).toBe('markdown');
    expect(detectKind('data.csv', 'application/octet-stream')).toBe('csv');
  });

  it('uses the mime type when the extension says nothing', () => {
    expect(detectKind('download', 'application/pdf')).toBe('pdf');
    expect(detectKind('attachment', 'text/csv')).toBe('csv');
  });

  it('ignores mime parameters', () => {
    expect(detectKind('x', 'text/html; charset=utf-8')).toBe('html');
  });

  it('falls through when neither says anything', () => {
    expect(detectKind('mystery', '')).toBe('unknown');
    expect(detectKind('mystery')).toBe('unknown');
  });

  it('is case insensitive about extensions', () => {
    expect(detectKind('REPORT.PDF')).toBe('pdf');
  });
});

describe('parseDocument', () => {
  it('parses markdown', async () => {
    const result = await parseDocument('notes.md', await bytesOf('notes.md'));
    expect(result.kind).toBe('markdown');
    expect(result.text).toContain('LX-88213');
  });

  it('parses a real PDF and reports its page count', async () => {
    const result = await parseDocument('quarterly-notes.pdf', await bytesOf('quarterly-notes.pdf'));
    expect(result.kind).toBe('pdf');
    expect(result.text).toContain('March 14th');
    expect(result.metadata.pages).toBe(1);
  });

  it('parses a real DOCX', async () => {
    const result = await parseDocument('onboarding.docx', await bytesOf('onboarding.docx'));
    expect(result.kind).toBe('docx');
    expect(result.text).toContain('VPN access');
  });

  it('rejects a binary file rather than storing mojibake', async () => {
    // Without a fatal decoder this "succeeds" into nonsense the agent then
    // quotes as fact, which is worse than a refusal.
    await expect(parseDocument('binary.bin', await bytesOf('binary.bin'))).rejects.toThrow();
  });

  it('rejects invalid JSON', async () => {
    await expect(parseDocument('broken.json', encode('{"a": '))).rejects.toThrow(/not valid JSON/);
  });

  it('re-serialises JSON with indentation', async () => {
    const result = await parseDocument('config.json', await bytesOf('config.json'));
    expect(result.text).toContain('\n  "service"');
  });

  it('accepts JSON Lines', async () => {
    const result = await parseDocument('events.json', encode('{"a":1}\n{"a":2}\n'));
    expect(result.metadata.records).toBe(2);
    expect(result.metadata.top_level_type).toBe('jsonl');
  });

  it('strips a leading byte-order mark', async () => {
    const result = await parseDocument('bom.txt', encode('﻿hello'));
    expect(result.text).toBe('hello');
  });
});

describe('parseCsv', () => {
  it('reports its columns and row count', async () => {
    const result = await parseDocument('expenses.csv', await bytesOf('expenses.csv'));
    expect(result.metadata.columns).toEqual(['date', 'vendor', 'amount', 'category']);
    // The header is not a row.
    expect(result.metadata.rows).toBe(3);
  });

  it('repeats the header into every row', async () => {
    // A bare row of values separated from its header is not something the agent
    // can reason about once it has been chunked.
    const result = await parseDocument('expenses.csv', await bytesOf('expenses.csv'));
    expect(result.text).toContain('vendor: Rail Europe');
  });

  it('handles a quoted field containing the delimiter', async () => {
    const result = await parseDocument('expenses.csv', await bytesOf('expenses.csv'));
    expect(result.text).toContain('Cafe, Central');
  });

  it('handles an escaped quote', async () => {
    const result = await parseDocument('expenses.csv', await bytesOf('expenses.csv'));
    expect(result.text).toContain('He said "hello"');
  });

  it('handles an embedded newline inside a quoted field', () => {
    const result = parseCsv('a,b\n"line one\nline two",second\n', 'x.csv');
    expect(result.metadata.rows).toBe(1);
    expect(result.text).toContain('line one\nline two');
  });

  it('uses tabs for a .tsv file', () => {
    const result = parseCsv('a\tb\n1\t2\n', 'x.tsv');
    expect(result.metadata.columns).toEqual(['a', 'b']);
    expect(result.metadata.rows).toBe(1);
  });

  it('drops trailing blank lines, which every spreadsheet export produces', () => {
    const result = parseCsv('a,b\n1,2\n\n\n', 'x.csv');
    expect(result.metadata.rows).toBe(1);
  });

  it('omits empty cells rather than rendering them as blank', () => {
    const result = parseCsv('a,b,c\n1,,3\n', 'x.csv');
    expect(result.text).toContain('a: 1');
    expect(result.text).toContain('c: 3');
    expect(result.text).not.toContain('b:');
  });

  it('handles a header-only file', () => {
    const result = parseCsv('a,b\n', 'x.csv');
    expect(result.metadata.rows).toBe(0);
  });
});

describe('stripHtml', () => {
  it('keeps the title', () => {
    expect(stripHtml('<title>Reading list</title><body>x</body>').metadata.title).toBe('Reading list');
  });

  it('drops script and style content', () => {
    const result = stripHtml('<style>p{color:red}</style><script>alert(1)</script><p>keep</p>');
    expect(result.text).not.toContain('color:red');
    expect(result.text).not.toContain('alert(1)');
    expect(result.text).toContain('keep');
  });

  it('renders list items as bullets', () => {
    expect(stripHtml('<ul><li>First</li><li>Second</li></ul>').text).toContain('- First');
  });

  it('decodes named entities', () => {
    expect(stripHtml('<p>a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39;</p>').text).toBe(
      'a b & c <d> "e" \'f\'',
    );
  });

  it('turns block boundaries into paragraph breaks', () => {
    expect(stripHtml('<p>one</p><p>two</p>').text).toBe('one\n\ntwo');
  });

  it('drops html comments', () => {
    expect(stripHtml('<!-- hidden --><p>shown</p>').text).toBe('shown');
  });
});
