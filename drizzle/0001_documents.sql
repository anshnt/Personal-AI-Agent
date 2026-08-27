-- The trigram index on documents.name needs pg_trgm. Drizzle does not emit
-- extension statements, so it is added here by hand.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('text', 'markdown', 'json', 'csv', 'html', 'pdf', 'docx', 'unknown');--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"char_offset" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "document_kind" DEFAULT 'text' NOT NULL,
	"mime_type" text,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_document_ordinal_unique" ON "document_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "document_chunks_content_fts_idx" ON "document_chunks" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "document_chunks_user_idx" ON "document_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_user_created_idx" ON "documents" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "documents_user_hash_unique" ON "documents" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "documents_name_trgm_idx" ON "documents" USING gin ("name" gin_trgm_ops);