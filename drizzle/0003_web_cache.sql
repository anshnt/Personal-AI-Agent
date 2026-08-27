CREATE TYPE "public"."web_cache_kind" AS ENUM('search', 'fetch');--> statement-breakpoint
CREATE TABLE "web_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "web_cache_kind" NOT NULL,
	"cache_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_cache" ADD CONSTRAINT "web_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "web_cache_user_kind_key_unique" ON "web_cache" USING btree ("user_id","kind","cache_key");--> statement-breakpoint
CREATE INDEX "web_cache_expires_idx" ON "web_cache" USING btree ("expires_at");