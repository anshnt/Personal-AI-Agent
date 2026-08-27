-- Semantic memory recall, added only where the database can support it.
--
-- pgvector is not available on every PostgreSQL install, and a plain
-- `CREATE EXTENSION vector` would make this migration fail for everyone who
-- does not have it — turning an optional feature into a hard requirement. So
-- the whole thing is conditional: where the extension is available it is
-- created and the column and index are added; where it is not, this migration
-- is a no-op and recall stays lexical.
--
-- `embedding_model` is stored alongside the vector because vectors from
-- different models are not comparable. Recall filters on it, so changing
-- provider degrades to lexical until a backfill has run rather than returning
-- nonsense.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;

    ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1024);
    ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding_model" text;

    -- HNSW rather than IVFFlat: it needs no training pass, so it works on an
    -- empty table and stays correct as rows are added one at a time, which is
    -- exactly how a personal agent accumulates memories.
    CREATE INDEX IF NOT EXISTS "memories_embedding_hnsw_idx"
      ON "memories" USING hnsw ("embedding" vector_cosine_ops);

    -- Recall filters on the model, so it belongs in an index too.
    CREATE INDEX IF NOT EXISTS "memories_embedding_model_idx"
      ON "memories" ("user_id", "embedding_model");

    RAISE NOTICE 'pgvector found: semantic memory recall is available';
  ELSE
    RAISE NOTICE 'pgvector not available: memory recall will stay lexical';
  END IF;
END $$;
