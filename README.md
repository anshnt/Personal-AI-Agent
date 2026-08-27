# Personal AI Agent

An assistant for one person. It remembers you across conversations, keeps your task
list, and reaches outside services through tools — and it shows you every tool call
it made to get to an answer.

Built on Next.js, TypeScript, PostgreSQL, and the AI SDK with tool calling.

## What it does

| Capability | How it works |
| --- | --- |
| **Remembers you** | Durable memory in Postgres, classified as facts, preferences, episodes, and standing directives. Relevant memories are recalled into the system prompt on every turn. |
| **Learns without being told** | After each exchange a background pass mines the turn for anything worth keeping and writes it away. No "remember this" required. |
| **Manages tasks** | Full task store with priorities, tags, due dates, and status. The agent creates and updates them as a side effect of ordinary conversation. |
| **Gets dates right** | A deterministic date resolver, so "next Tuesday at 9" becomes a real timestamp in your timezone instead of something the model guessed. |
| **Reads your files** | Uploads and local files are parsed (txt, md, json, csv, html, pdf, docx), chunked, and indexed. The agent searches for a passage, then reads around it. |
| **Shows its work** | Every tool call and its result is rendered inline, collapsed. Every execution is also written to an audit table. |

Reading email, searching the web, scheduling, and external API connectors land in
follow-up work; the tool layer is built to take them without changes to the agent
loop.

## Getting started

You need Node 20.9+ and a PostgreSQL 14+ database.

```bash
npm install
cp .env.example .env.local     # then fill in DATABASE_URL and ANTHROPIC_API_KEY
npm run db:migrate
npm run dev
```

Open http://localhost:3000.

### Configuration

Only two variables are required:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `ANTHROPIC_API_KEY` | From [the console](https://console.anthropic.com/settings/keys). |

The rest have working defaults — identity (`DEFAULT_USER_EMAIL`,
`DEFAULT_USER_NAME`, `DEFAULT_USER_TIMEZONE`), models (`AGENT_MODEL`,
`UTILITY_MODEL`), and loop bounds (`AGENT_EFFORT`, `MAX_AGENT_STEPS`). See
`.env.example` for the full list.

`AGENT_FILES_DIR` is the one worth a second look: setting it gives the agent
read access to that directory and nothing else. Unset, local file access does
not exist. There is no default on purpose.

Set `DEFAULT_USER_TIMEZONE` to your own IANA zone. Every date the agent reasons
about resolves through it, and the default of `UTC` will quietly give you wrong
due dates.

## How it fits together

```
Browser (useChat)
  │  POST /api/chat  { id, messages }
  ▼
src/app/api/chat/route.ts
  ├── resolve user ─────────── users table, created on first use
  ├── recall memories ──────── ranked against this turn's text
  ├── load open tasks ──────── primed into the prompt, no lookup needed
  ├── build system prompt ──── stable instructions first, volatile context last
  │
  ├── streamText ───────────── model + tools, bounded by MAX_AGENT_STEPS
  │     └── tools ─────────── memory · tasks · time · documents
  │           └── each one audited to tool_executions
  │
  └── onFinish (after the user already has their answer)
        ├── persist messages
        ├── title the conversation, once
        └── mine the exchange for durable memories
```

### Layout

```
src/
  app/
    api/chat/route.ts        the agent loop
    api/conversations/       history, for the sidebar
    api/memories/            inspect and add memories directly
    api/tasks/               task list outside the chat
    api/documents/           upload, list, read, delete
    page.tsx, layout.tsx     the UI shell
  components/
    chat.tsx                 conversation view and composer
    message-parts.tsx        text, reasoning, and tool traces
  lib/
    ai/provider.ts           model selection and provider options
    ai/prompts.ts            system prompt construction
    conversations.ts         message persistence and titling
    db/schema.ts             the whole data model
    db/users.ts              identity resolution
    memory/store.ts          write, recall, revise, forget
    memory/extract.ts        background memory mining
    documents/parse.ts       file formats to plain text
    documents/chunk.ts       retrieval chunking with overlap
    documents/store.ts       ingest, index, search, read
    documents/local-files.ts sandboxed filesystem access
    tasks/store.ts           task CRUD and querying
    time.ts                  timezone-correct date maths
    tools/                   the tool surface the model sees
drizzle/                     migrations
scripts/
  smoke.ts                   memory, tasks, conversations, time
  smoke-documents.ts         parsing, chunking, search, file sandbox
  fixtures/                  real pdf, docx, csv, html to parse
```

## Design notes

**Tools close over the user, they don't take a user argument.** Every tool is
constructed per request with the acting identity baked in, so no tool input the
model produces can reach another user's data. Cross-tenant access is covered in
the smoke checks.

**Tools never throw at the model.** A thrown tool aborts the whole turn, which is
the wrong failure mode — the model can usually recover from being told "that
lookup failed". `instrument()` in `lib/tools/context.ts` catches, returns a
structured `{ ok: false, error }`, and writes an audit row either way.

**Recall matches on any term, not all of them.** The obvious choice,
`websearch_to_tsquery`, ANDs every word, so recalling "running marathon training"
misses "training for a half marathon". Queries are tokenized to bare
alphanumerics and OR-joined instead, which also makes `to_tsquery` injection-proof.
Ranking then sorts out which memory actually fits.

**Deleting a memory is gated on text match alone.** Recall blends text match with
importance and recency for ranking, but `forgetMatching` thresholds on the text
component only — blending importance in would make an important memory *easier*
to delete by accident.

**Corrections supersede, they don't overwrite.** "I moved to Berlin" should not
erase the fact that you lived somewhere else. The old row is retained and pointed
at its replacement, so a wrong correction is recoverable.

**The prompt is ordered for cache hits.** Frozen instructions, then slow-moving
identity, then the volatile recall block and timestamp last — so the cached prefix
survives from turn to turn.

**Background work happens after the response.** Memory extraction and titling run
in `onFinish`, best-effort, and their failures are logged rather than surfaced.
The user already has their answer; a failed extraction should not look like a
failed conversation.

**Filesystem access is deny-by-default and checked twice.** A path is first
checked lexically, which rejects `../` traversal before any syscall, then
resolved with `realpath` and re-checked — which is what catches a symlink inside
the root pointing out of it. A `..` check on the raw string does not. Both
escapes, plus NUL-byte truncation, are covered in the smoke checks.

**A parse either works or fails; it never half-works.** UTF-8 decoding is
`fatal`, so a binary file is rejected instead of becoming mojibake the agent
would go on to quote as fact. A scanned PDF with no text layer is reported as
needing OCR rather than returned empty.

**Search returns passages, not documents.** A 40-page PDF matches almost any
query, so retrieval is chunk-level with `ts_headline` excerpts, and chunks
overlap — otherwise "the deadline is" and "March 14th" land either side of a
boundary and neither is retrievable.

**Re-ingesting the same bytes replaces, it does not duplicate.** Documents are
keyed by content hash per user, so syncing a folder twice is idempotent.

**Single-tenant by configuration, multi-tenant by schema.** Every table is keyed
by user and every query filters on it. Adding real auth means changing
`resolveCurrentUser()` and nothing else.

## Verification

```bash
npm run typecheck
npm run smoke      # needs DATABASE_URL pointing at a scratch database
npm run build
```

The smoke scripts run against real PostgreSQL and real files, which is the point.
136 checks cover full-text recall, array overlap filters, upsert paths, cascades,
cross-tenant isolation, local-time anchoring across DST transition days and
45-minute offsets, PDF and DOCX extraction from actual bytes, CSV quoting rules,
chunk boundary and overlap invariants, and every filesystem escape the sandbox is
supposed to refuse — including symlinks out of the root and NUL-byte truncation.

They delete all rows in the target database. Point them at a scratch one.

## License

MIT
