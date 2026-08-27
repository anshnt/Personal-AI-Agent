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
/* Email                                                                      */
/* -------------------------------------------------------------------------- */

export const mailProvider = pgEnum('mail_provider', ['imap', 'local']);

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: mailProvider().notNull(),
    /** The mailbox address, for display and for "who is this from" reasoning. */
    address: text().notNull(),
    /**
     * Non-secret connection settings: host, port, mailbox name, directory path.
     *
     * Credentials deliberately do not live here. They are read from the
     * environment at connect time, so a database dump never carries them.
     */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Cursor for incremental sync: the newest message already stored. */
    syncedThrough: timestamp({ withTimezone: true }),
    lastSyncedAt: timestamp({ withTimezone: true }),
    lastSyncError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('email_accounts_user_address_unique').on(table.userId, table.address)],
);

export const emails = pgTable(
  'emails',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => emailAccounts.id, { onDelete: 'cascade' }),
    /**
     * RFC 5322 Message-ID, or a hash of the raw bytes when the header is absent.
     * This is the dedupe key: re-syncing a mailbox must not duplicate messages.
     */
    messageId: text().notNull(),
    /** Provider-native id (IMAP UID, filename), for fetching the original. */
    externalId: text(),
    /** References/In-Reply-To root, so a conversation can be grouped. */
    threadKey: text(),
    fromAddress: text().notNull(),
    fromName: text(),
    toAddresses: text().array().notNull().default(sql`ARRAY[]::text[]`),
    ccAddresses: text().array().notNull().default(sql`ARRAY[]::text[]`),
    subject: text().notNull().default(''),
    /** Plain text body. HTML-only mail is converted before storage. */
    bodyText: text().notNull().default(''),
    /** First line or so, for listings that should not carry a whole body. */
    snippet: text().notNull().default(''),
    attachmentNames: text().array().notNull().default(sql`ARRAY[]::text[]`),
    labels: text().array().notNull().default(sql`ARRAY[]::text[]`),
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('emails_account_message_unique').on(table.accountId, table.messageId),
    index('emails_user_received_idx').on(table.userId, table.receivedAt.desc()),
    index('emails_user_from_idx').on(table.userId, table.fromAddress),
    index('emails_thread_idx').on(table.userId, table.threadKey),
    // Subject is weighted above the body so a search for a subject line ranks it
    // first, rather than losing to a message that mentions the words in passing.
    index('emails_search_idx').using(
      'gin',
      sql`(
        setweight(to_tsvector('english', coalesce(${table.subject}, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(${table.fromName}, '') || ' ' || ${table.fromAddress}), 'B') ||
        setweight(to_tsvector('english', coalesce(${table.bodyText}, '')), 'C')
      )`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* Web access cache                                                           */
/* -------------------------------------------------------------------------- */

export const webCacheKind = pgEnum('web_cache_kind', ['search', 'fetch']);

/**
 * Cache for outbound web calls.
 *
 * Search APIs are metered and page fetches are slow, and an agent re-asks the
 * same question constantly across a multi-step turn. Keyed per user so one
 * person's browsing is never served to another.
 */
export const webCache = pgTable(
  'web_cache',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: webCacheKind().notNull(),
    /** The search query or the URL. */
    cacheKey: text().notNull(),
    payload: jsonb().$type<unknown>().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('web_cache_user_kind_key_unique').on(table.userId, table.kind, table.cacheKey),
    index('web_cache_expires_idx').on(table.expiresAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Schedules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `reminder`  — surface a message to the user at a time.
 * `agent_run` — run a prompt through the agent, with all its tools available,
 *               so a schedule can actually do work rather than just nag.
 */
export const scheduleKind = pgEnum('schedule_kind', ['reminder', 'agent_run']);

export const scheduleStatus = pgEnum('schedule_status', [
  'active',
  'paused',
  'completed',
  'failed',
]);

export const schedules = pgTable(
  'schedules',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    kind: scheduleKind().notNull().default('reminder'),
    /**
     * What to do when it fires: the reminder text, or the prompt to run.
     * Written by the agent at creation time, read back at fire time.
     */
    payload: text().notNull(),

    /* --- timing: exactly one of cron or runAt --- */

    /** Five-field cron expression, for a recurring schedule. */
    cron: text(),
    /** Timezone the cron is evaluated in. Never the server's. */
    timezone: text().notNull().default('UTC'),
    /** Fire time, for a one-shot schedule. */
    runAt: timestamp({ withTimezone: true }),

    /* --- state --- */

    status: scheduleStatus().notNull().default('active'),
    /** When this is next due. The runner's only query predicate. */
    nextRunAt: timestamp({ withTimezone: true }),
    lastRunAt: timestamp({ withTimezone: true }),
    runCount: integer().notNull().default(0),
    /** Stop after this many runs. Null means indefinitely. */
    maxRuns: integer(),
    consecutiveFailures: integer().notNull().default(0),
    lastError: text(),
    sourceConversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The runner's hot path: due-and-active, oldest first.
    index('schedules_due_idx').on(table.status, table.nextRunAt),
    index('schedules_user_idx').on(table.userId, table.status),
  ],
);

export const scheduleRunStatus = pgEnum('schedule_run_status', [
  'running',
  'succeeded',
  'failed',
  'skipped',
]);

/**
 * One row per firing.
 *
 * A schedule that quietly stopped working is the worst failure mode for this
 * feature — the user finds out by missing something. The run log is what makes
 * that visible, and it is what the agent reads to answer "did that run?".
 */
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    scheduleId: uuid()
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: scheduleRunStatus().notNull().default('running'),
    /** When this firing was due, as distinct from when it actually ran. */
    scheduledFor: timestamp({ withTimezone: true }).notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    /** What the run produced: the reminder text, or the agent's answer. */
    output: text(),
    error: text(),
    /** Set when the user has seen it. Unread runs are what get surfaced. */
    acknowledgedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index('schedule_runs_schedule_idx').on(table.scheduleId, table.startedAt.desc()),
    index('schedule_runs_user_unread_idx').on(table.userId, table.acknowledgedAt),
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
export type EmailAccount = typeof emailAccounts.$inferSelect;
export type NewEmailAccount = typeof emailAccounts.$inferInsert;
export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type MailProviderKind = EmailAccount['provider'];
export type WebCacheEntry = typeof webCache.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
export type ScheduleRun = typeof scheduleRuns.$inferSelect;
export type ScheduleKind = Schedule['kind'];
export type ScheduleStatus = Schedule['status'];
export type MemoryKind = Memory['kind'];
export type TaskStatus = Task['status'];
