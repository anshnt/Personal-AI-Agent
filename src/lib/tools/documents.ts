import { tool } from 'ai';
import { z } from 'zod';

import {
  countChunks,
  deleteDocument,
  findDocumentsByName,
  getChunks,
  getDocument,
  ingestDocument,
  listDocuments,
  searchDocuments,
} from '@/lib/documents/store';
import {
  FileAccessError,
  filesRoot,
  listLocalFiles,
  readLocalFile,
} from '@/lib/documents/local-files';
import { failure, instrument, type AgentContext } from './context';
import { id } from './schemas';

/** How much document text one `read_document` call may return. */
const READ_WINDOW_CHARS = 12_000;

export function documentTools(context: AgentContext) {
  return {
    search_documents: tool({
      description:
        "Search the text of the user's stored documents. Returns matching passages with the document they came from, not whole files. Use this before answering anything that might be written down in their files.",
      inputSchema: z.object({
        query: z.string().min(2).max(300),
        document_ids: z
          .array(id)
          .max(10)
          .optional()
          .describe('Restrict the search to specific documents.'),
        limit: z.number().int().min(1).max(30).default(8),
      }),
      execute: instrument('search_documents', context, async (input) => {
        const hits = await searchDocuments({
          userId: context.user.id,
          query: input.query,
          documentIds: input.document_ids,
          limit: input.limit,
        });

        return {
          ok: true as const,
          count: hits.length,
          hits: hits.map((hit) => ({
            document_id: hit.documentId,
            document_name: hit.documentName,
            kind: hit.kind,
            chunk: hit.ordinal,
            excerpt: hit.excerpt,
            relevance: Number(hit.relevance.toFixed(3)),
          })),
          // Without this the model tends to answer from a 40-word excerpt.
          next_step:
            hits.length > 0
              ? 'Call read_document with a document_id and from_chunk to read the surrounding text before quoting it.'
              : 'Nothing matched. Try different words, or list_documents to see what is stored.',
        };
      }),
    }),

    list_documents: tool({
      description:
        'List the documents stored for the user, newest first. Use it to see what is available before searching.',
      inputSchema: z.object({
        name_contains: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: instrument('list_documents', context, async (input) => {
        const rows = input.name_contains
          ? await findDocumentsByName(context.user.id, input.name_contains)
          : await listDocuments(context.user.id, input.limit);

        return {
          ok: true as const,
          count: rows.length,
          documents: rows.map((document) => ({
            id: document.id,
            name: document.name,
            kind: document.kind,
            size_bytes: document.sizeBytes,
            characters: document.content.length,
            source: document.source,
            metadata: document.metadata,
            added_at: document.createdAt.toISOString(),
          })),
        };
      }),
    }),

    read_document: tool({
      description:
        'Read a window of a document. Start from the chunk that search_documents pointed at, or from chunk 0 to read from the beginning. Returns whether more text follows.',
      inputSchema: z.object({
        document_id: id,
        from_chunk: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Chunk index to start from. search_documents reports this.'),
        chunks: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(3)
          .describe('How many consecutive chunks to read. Each is roughly 1400 characters.'),
      }),
      execute: instrument('read_document', context, async (input) => {
        const document = await getDocument(context.user.id, input.document_id);
        if (!document) return failure('No document with that id belongs to this user.');

        const total = await countChunks(context.user.id, input.document_id);

        // A document short enough to have no chunks still has content.
        if (total === 0) {
          return {
            ok: true as const,
            document_name: document.name,
            kind: document.kind,
            from_chunk: 0,
            chunks_returned: 0,
            total_chunks: 0,
            has_more: false,
            text: document.content.slice(0, READ_WINDOW_CHARS),
          };
        }

        const rows = await getChunks(
          context.user.id,
          input.document_id,
          input.from_chunk,
          input.chunks,
        );

        if (rows.length === 0) {
          return failure(
            `Chunk ${input.from_chunk} is past the end of this document, which has ${total} chunks.`,
          );
        }

        const lastOrdinal = rows[rows.length - 1]?.ordinal ?? input.from_chunk;

        return {
          ok: true as const,
          document_name: document.name,
          kind: document.kind,
          from_chunk: rows[0]?.ordinal ?? input.from_chunk,
          chunks_returned: rows.length,
          total_chunks: total,
          has_more: lastOrdinal + 1 < total,
          next_chunk: lastOrdinal + 1 < total ? lastOrdinal + 1 : null,
          // Chunks overlap by design, so joining them repeats a little text.
          text: rows
            .map((chunk) => chunk.content)
            .join('\n\n')
            .slice(0, READ_WINDOW_CHARS),
        };
      }),
    }),

    forget_document: tool({
      description:
        'Delete a stored document and its search index permanently. Only use it when the user asks.',
      inputSchema: z.object({ document_id: id }),
      execute: instrument('forget_document', context, async (input) => {
        const deleted = await deleteDocument(context.user.id, input.document_id);
        return deleted
          ? { ok: true as const, deleted: true }
          : failure('No document with that id belongs to this user.');
      }),
    }),

    list_files: tool({
      description:
        "List files in the user's configured files directory. Paths are relative to that directory. Only available when the operator has enabled local file access.",
      inputSchema: z.object({
        path: z.string().max(400).default('.').describe('Directory to list, relative to the root.'),
        recursive: z.boolean().default(false),
      }),
      execute: instrument('list_files', context, async (input) => {
        try {
          const root = await filesRoot();
          if (!root) {
            return failure(
              'Local file access is not enabled. The operator would need to set AGENT_FILES_DIR.',
            );
          }

          const entries = await listLocalFiles(input.path, { recursive: input.recursive });
          return {
            ok: true as const,
            count: entries.length,
            entries: entries.map((entry) => ({
              path: entry.path,
              kind: entry.kind,
              size_bytes: entry.sizeBytes,
              modified_at: entry.modifiedAt,
            })),
          };
        } catch (error) {
          if (error instanceof FileAccessError) return failure(error.message);
          throw error;
        }
      }),
    }),

    read_file: tool({
      description:
        "Read a file from the user's files directory and index it so it becomes searchable. Returns the beginning of the text; use search_documents and read_document for the rest. Supports txt, md, json, csv, html, pdf, and docx.",
      inputSchema: z.object({
        path: z.string().min(1).max(400).describe('Path relative to the files directory.'),
      }),
      execute: instrument('read_file', context, async (input) => {
        try {
          const file = await readLocalFile(input.path);

          const result = await ingestDocument({
            userId: context.user.id,
            name: file.path,
            bytes: file.bytes,
            source: `local:${file.path}`,
          });

          return {
            ok: true as const,
            document_id: result.document.id,
            name: result.document.name,
            kind: result.document.kind,
            characters: result.document.content.length,
            chunks: result.chunks,
            already_indexed: result.replaced,
            metadata: result.document.metadata,
            preview: result.document.content.slice(0, READ_WINDOW_CHARS),
            has_more: result.document.content.length > READ_WINDOW_CHARS,
          };
        } catch (error) {
          if (error instanceof FileAccessError) return failure(error.message);
          // Parse failures are expected and actionable, so they are reported
          // rather than allowed to abort the turn.
          if (error instanceof Error) return failure(error.message);
          throw error;
        }
      }),
    }),
  };
}
