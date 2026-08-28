-- These are internal bot projections, not a browser-facing Data API. Public
-- schema placement is retained for foreign-key compatibility, while RLS and
-- explicit grants prevent anon/authenticated access and cascading deletes.
ALTER TABLE "public"."telegram_chats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."telegram_users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."telegram_chats" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "public"."telegram_users" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE "public"."telegram_chats" FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE "public"."telegram_users" FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE "public"."telegram_chats" FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE "public"."telegram_users" FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "public"."telegram_chats" TO telegram_bot;
    GRANT SELECT, INSERT, UPDATE ON TABLE "public"."telegram_users" TO telegram_bot;

    CREATE POLICY "telegram_bot_internal_access"
      ON "public"."telegram_chats"
      FOR ALL
      TO telegram_bot
      USING (true)
      WITH CHECK (true);

    CREATE POLICY "telegram_bot_internal_access"
      ON "public"."telegram_users"
      FOR ALL
      TO telegram_bot
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
