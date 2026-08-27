ALTER TABLE "moderation"."pending_operations"
  ADD COLUMN "supersession_key" text;
--> statement-breakpoint
UPDATE "moderation"."pending_operations"
SET "supersession_key" = 'moderation.member-state:' || "chat_id" || ':' || ("request_payload" ->> 'user_id')
WHERE "kind" IN (
    'telegram.banChatMember',
    'telegram.unbanChatMember',
    'telegram.kick',
    'telegram.restrictChatMember.mute',
    'telegram.restrictChatMember.unmute'
  )
  AND "request_payload" ? 'user_id';
--> statement-breakpoint
UPDATE "moderation"."pending_operations"
SET "supersession_key" = 'telegram.setMyCommands:' || COALESCE("request_payload" ->> 'language_code', 'default')
WHERE "kind" = 'integration.telegram.setMyCommands'
  AND "request_payload" ? 'commands';
--> statement-breakpoint
CREATE INDEX "pending_operations_owner_supersession_created_idx"
  ON "moderation"."pending_operations" USING btree ("owner_id", "supersession_key", "created_at");
