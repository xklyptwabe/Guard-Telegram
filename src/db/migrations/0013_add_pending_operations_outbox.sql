-- BOTS-9: write-ahead log / outbox for external operations (currently
-- Telegram Bot API moderation calls: ban, unban, restrict, unrestrict,
-- kick, and the bot's own message deletions). See
-- src/db/schema/moderation.ts and
-- docs/modules/0009-external-operation-outbox.md for the full contract.
--
-- This is intentionally a separate schema/table from "audit"."outbox"
-- (BOTS-6/7), which delivers an *already-recorded* audit event onward to a
-- destination. This table exists to make the external call itself
-- reliable, before any audit event is written.
CREATE SCHEMA IF NOT EXISTS "moderation";
--> statement-breakpoint
CREATE TABLE "moderation"."pending_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"chat_id" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"metadata" jsonb,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_operations_idempotency_key_idx" ON "moderation"."pending_operations" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "pending_operations_status_next_attempt_idx" ON "moderation"."pending_operations" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "pending_operations_chat_idx" ON "moderation"."pending_operations" USING btree ("chat_id");
