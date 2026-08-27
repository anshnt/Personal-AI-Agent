CREATE TABLE "connector_usage" (
	"user_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "connector_usage_user_id_connector_window_start_pk" PRIMARY KEY("user_id","connector","window_start")
);
--> statement-breakpoint
ALTER TABLE "connector_usage" ADD CONSTRAINT "connector_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_usage_window_idx" ON "connector_usage" USING btree ("window_start");