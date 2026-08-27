CREATE TYPE "public"."mail_provider" AS ENUM('imap', 'local');--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "mail_provider" NOT NULL,
	"address" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_through" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"external_id" text,
	"thread_key" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_addresses" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"cc_addresses" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"attachment_names" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"labels" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_account_id_email_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."email_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_user_address_unique" ON "email_accounts" USING btree ("user_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_account_message_unique" ON "emails" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX "emails_user_received_idx" ON "emails" USING btree ("user_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "emails_user_from_idx" ON "emails" USING btree ("user_id","from_address");--> statement-breakpoint
CREATE INDEX "emails_thread_idx" ON "emails" USING btree ("user_id","thread_key");--> statement-breakpoint
CREATE INDEX "emails_search_idx" ON "emails" USING gin ((
        setweight(to_tsvector('english', coalesce("subject", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("from_name", '') || ' ' || "from_address"), 'B') ||
        setweight(to_tsvector('english', coalesce("body_text", '')), 'C')
      ));