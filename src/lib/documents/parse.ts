/**
 * Turn an uploaded file into plain text the agent can read and search.
 *
 * Every parser here is chosen to be dependency-light and to fail loudly rather
 * than silently returning garbage: a document that parsed into mojibake is worse
 * than one that was rejected, because the agent will confidently quote it.
 */

export type DocumentKind =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'unknown';

export interface ParsedDocument {
  kind: DocumentKind;
  text: string;
  /** Anything structural worth keeping: page count, column names, and so on. */
  metadata: Record<string, unknown>;
}

/** Hard cap on extracted text. Beyond this a document is truncated, not rejected. */
export const MAX_DOCUMENT_CHARS = 400_000;

const EXTENSION_KINDS: Record<string, DocumentKind> = {
  txt: 'text',
  log: 'text',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  json: 'json',
  jsonl: 'json',
  csv: 'csv',
  tsv: 'csv',
  html: 'html',
  htm: 'html',
  xml: 'html',
  pdf: 'pdf',
  docx: 'docx',
};

const MIME_KINDS: Record<string, DocumentKind> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'text/html': 'html',
  'application/xml': 'html',
  'text/xml': 'html',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * Decide how to parse a file.
 *
 * The extension wins over the MIME type: browsers report
 * `application/octet-stream` for plenty of perfectly ordinary files, and a
 * generic MIME type should not defeat an unambiguous `.md`.
 */
export function detectKind(fileName: string, mimeType?: string): DocumentKind {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const byExtension = EXTENSION_KINDS[extension];
  if (byExtension) return byExtension;

  const normalisedMime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_KINDS[normalisedMime] ?? 'unknown';
}

export async function parseDocument(
  fileName: string,
  bytes: Uint8Array,
  mimeType?: string,
): Promise<ParsedDocument> {
  const kind = detectKind(fileName, mimeType);

  switch (kind) {
    case 'pdf':
      return parsePdf(bytes);
    case 'docx':
      return parseDocx(bytes);
    case 'html':
      return { kind, ...stripHtml(decodeUtf8(bytes)) };
    case 'csv':
      return parseCsv(decodeUtf8(bytes), fileName);
    case 'json':
      return parseJson(decodeUtf8(bytes));
    case 'text':
    case 'markdown':
      return { kind, text: truncate(decodeUtf8(bytes)), metadata: {} };
    default:
      return parseUnknown(bytes);
  }
}

/**
 * Decode as UTF-8, rejecting anything that is not valid text.
 *
 * `fatal: true` matters: without it invalid bytes become replacement characters
 * and a binary file parses "successfully" into nonsense.
 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('That file is not valid UTF-8 text.');
  }
}

function truncate(text: string): string {
  const normalised = text
    .replace(/\r\n/g, '\n')
    // Strip a leading byte-order mark and any stray NULs, both of which show up
    // in real-world exports and confuse downstream tokenisation.
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '');
  return normalised.length <= MAX_DOCUMENT_CHARS
    ? normalised
    : `${normalised.slice(0, MAX_DOCUMENT_CHARS)}\n\n[truncated: document exceeds ${MAX_DOCUMENT_CHARS} characters]`;
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  // Imported lazily: the PDF machinery is large and most uploads are not PDFs.
  const { extractText, getDocumentProxy } = await import('unpdf');

  try {
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join('\n\n') : text;

    if (merged.trim().length === 0) {
      throw new Error(
        'That PDF has no extractable text. It is probably a scan, which needs OCR first.',
      );
    }

    return { kind: 'pdf', text: truncate(merged), metadata: { pages: totalPages } };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('That PDF')) throw error;
    throw new Error(`Could not read that PDF: ${error instanceof Error ? error.message : error}`);
  }
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  const mammoth = await import('mammoth');

  try {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    return {
      kind: 'docx',
      text: truncate(result.value),
      // Mammoth reports unsupported constructs rather than failing; surfacing
      // them tells the user why something is missing from the extraction.
      metadata: { warnings: result.messages.map((message) => message.message).slice(0, 20) },
    };
  } catch (error) {
    throw new Error(
      `Could not read that Word document: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Reduce HTML to readable text.
 *
 * Deliberately not a full parser: script and style content is dropped, block
 * boundaries become newlines, and entities are decoded. That is enough for the
 * agent to read a saved article without pulling in a DOM implementation.
 */
export function stripHtml(html: string): { text: string; metadata: Record<string, unknown> } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();

  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    // Collapse runs of whitespace, but keep paragraph breaks.
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  return {
    text: truncate(text),
    metadata: title ? { title } : {},
  };
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * Render a delimited file as text.
 *
 * The header row is repeated into each record so a chunk of the middle of a
 * spreadsheet is still interpretable on its own — a bare row of values that has
 * been separated from its header is not something the agent can reason about.
 */
export function parseCsv(raw: string, fileName: string): ParsedDocument {
  const delimiter = fileName.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  const rows = parseDelimited(raw, delimiter);

  if (rows.length === 0) {
    return { kind: 'csv', text: '', metadata: { rows: 0, columns: [] } };
  }

  const header = rows[0] ?? [];
  const body = rows.slice(1);

  const rendered = body
    .map((row, index) => {
      const fields = header
        .map((column, columnIndex) => {
          const value = row[columnIndex] ?? '';
          return value === '' ? null : `${column || `column ${columnIndex + 1}`}: ${value}`;
        })
        .filter((field): field is string => field !== null);
      return `Row ${index + 1} — ${fields.join('; ')}`;
    })
    .join('\n');

  return {
    kind: 'csv',
    text: truncate(rendered),
    metadata: { rows: body.length, columns: header },
  };
}

/** Minimal RFC 4180 reader: quoted fields, escaped quotes, embedded newlines. */
function parseDelimited(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inQuotes) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (char === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  // Drop trailing blank lines, which every spreadsheet export produces.
  return rows.filter((entry) => entry.some((value) => value.length > 0));
}

function parseJson(raw: string): ParsedDocument {
  try {
    const value: unknown = JSON.parse(raw);
    return {
      kind: 'json',
      // Re-serialised with indentation: models read formatted JSON far more
      // reliably than a single minified line.
      text: truncate(JSON.stringify(value, null, 2)),
      metadata: { top_level_type: Array.isArray(value) ? 'array' : typeof value },
    };
  } catch {
    // JSON Lines is common enough to be worth the second attempt.
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const parsed = lines.map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    });

    if (parsed.length > 0 && parsed.every((entry) => entry !== null)) {
      return {
        kind: 'json',
        text: truncate(parsed.map((entry) => JSON.stringify(entry, null, 2)).join('\n')),
        metadata: { top_level_type: 'jsonl', records: parsed.length },
      };
    }

    throw new Error('That file is not valid JSON or JSON Lines.');
  }
}

/**
 * Last resort for an unrecognised extension.
 *
 * Treated as text if it decodes cleanly as UTF-8 and looks like text; rejected
 * otherwise, rather than storing binary noise the agent would try to quote.
 */
function parseUnknown(bytes: Uint8Array): ParsedDocument {
  const text = decodeUtf8(bytes);

  const sample = text.slice(0, 4000);
  // Tab, newline, and carriage return are legitimate in text; any other C0 or
  // C1 control byte is a strong signal that this is not a text file.
  const controlCharacters =
    sample.replace(/[\t\n\r]/g, '').match(/[\u0000-\u001F\u007F-\u009F]/g)?.length ?? 0;
  if (sample.length > 0 && controlCharacters / sample.length > 0.02) {
    throw new Error('That file looks binary. Supported types: txt, md, json, csv, html, pdf, docx.');
  }

  return { kind: 'text', text: truncate(text), metadata: { detected: 'plain text' } };
}
