import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    name: text(),
    /** IANA timezone, used for every date the agent reasons about. */
    timezone: text().notNull().default('UTC'),
    /** Free-form profile the agent maintains: pronouns, role, working hours... */
    profile: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

export const conversations = pgTable(
  'conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversations_user_updated_idx').on(table.userId, table.updatedAt.desc())],
);

export const messageRole = pgEnum('message_role', ['system', 'user', 'assistant']);

export const messages = pgTable(
  'messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRole().notNull(),
    /**
     * AI SDK `UIMessage.parts`. Storing parts rather than flattened text keeps
     * reasoning, tool calls and tool results replayable across sessions.
     */
    parts: jsonb().$type<unknown[]>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('messages_conversation_created_idx').on(table.conversationId, table.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Long-term memory                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `fact`       — durable, atemporal ("works at Acme", "has a dog named Rex")
 * `preference` — how the user wants the agent to behave
 * `episode`    — something that happened, with a time reference
 * `directive`  — a standing instruction the agent must keep honouring
 */
export const memoryKind = pgEnum('memory_kind', ['fact', 'preference', 'episode', 'directive']);

export const memories = pgTable(
  'memories',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: memoryKind().notNull().default('fact'),
    /** One self-contained statement, written in the third person. */
    content: text().notNull(),
    /** Short topical tags used for cheap filtering ("work", "health", "travel"). */
    tags: text().array().notNull().default(sql`ARRAY[]::text[]`),
    /** 0..1 — how much this should influence future answers. */
    importance: real().notNull().default(0.5),
    /** Where it came from: `conversation:<id>`, `tool:<name>`, `manual`. */
    source: text().notNull().default('manual'),
    /** Set when a memory is superseded; kept for auditability. */
    supersededById: uuid(),
    /** Optional expiry for time-boxed facts ("is on holiday until Friday"). */
    expiresAt: timestamp({ withTimezone: true }),
    lastAccessedAt: timestamp({ withTimezone: true }),
    accessCount: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('memories_user_kind_idx').on(table.userId, table.kind),
    index('memories_user_importance_idx').on(table.userId, table.importance.desc()),
    // Lexical recall. The generated column keeps the index in sync on write.
    index('memories_content_fts_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

export const taskStatus = pgEnum('task_status', ['todo', 'in_progress', 'blocked', 'done', 'cancelled']);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    notes: text(),
    status: taskStatus().notNull().default('todo'),
    /** 1 (highest) .. 4 (lowest), mirroring common task-manager conventions. */
    priority: integer().notNull().default(3),
    tags: text().array().notNull().default(sql`ARRAY[]::text[]`),
    dueAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    /** Which conversation spawned this task, when applicable. */
    sourceConversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_user_status_idx').on(table.userId, table.status),
    index('tasks_user_due_idx').on(table.userId, table.dueAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

export const documentKind = pgEnum('document_kind', [
  'text',
  'markdown',
  'json',
  'csv',
  'html',
  'pdf',
  'docx',
  'unknown',
]);

export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    kind: documentKind().notNull().default('text'),
    mimeType: text(),
    sizeBytes: integer().notNull().default(0),
    /**
     * Content hash of the original bytes. Re-uploading the same file replaces
     * the existing row rather than accumulating duplicates.
     */
    contentHash: text().notNull(),
    /** Extracted plain text. Kept whole so a document can be read end to end. */
    content: text().notNull(),
    /** Structural detail from parsing: page count, CSV columns, HTML title. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Where it came from: `upload`, `local:<path>`, `email:<id>`. */
    source: text().notNull().default('upload'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('documents_user_created_idx').on(table.userId, table.createdAt.desc()),
    // The same file uploaded twice is the same document.
    uniqueIndex('documents_user_hash_unique').on(table.userId, table.contentHash),
    index('documents_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  ],
);

/**
 * Documents are chunked for retrieval.
 *
 * Searching whole documents returns too much to put in a prompt and ranks badly
 * — a 40-page PDF matches almost any query. Chunks give the agent a passage it
 * can quote, plus an offset so it can read around it.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Position of this chunk within its document, starting at 0. */
    ordinal: integer().notNull(),
    content: text().notNull(),
    /** Character offset into the document's full text, for reading around a hit. */
    charOffset: integer().notNull().default(0),
  },
  (table) => [
    uniqueIndex('document_chunks_document_ordinal_unique').on(table.documentId, table.ordinal),
    index('document_chunks_content_fts_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`,
    ),
    index('document_chunks_user_idx').on(table.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Observability                                                              */
/* -------------------------------------------------------------------------- */

/** One row per tool execution — the audit trail for everything the agent did. */
export const toolExecutions = pgTable(
  'tool_executions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'cascade' }),
    toolName: text().notNull(),
    input: jsonb().$type<unknown>(),
    output: jsonb().$type<unknown>(),
    ok: boolean().notNull().default(true),
    errorMessage: text(),
    durationMs: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tool_executions_user_created_idx').on(table.userId, table.createdAt.desc())],
);

/* -------------------------------------------------------------------------- */
/* Key/value settings, per user                                               */
/* -------------------------------------------------------------------------- */

export const settings = pgTable(
  'settings',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: jsonb().$type<unknown>().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type MemoryKind = Memory['kind'];
export type TaskStatus = Task['status'];
