CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TABLE "core"."chat_module_states" (
	"chat_id" text NOT NULL,
	"module_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_module_states_chat_id_module_id_pk" PRIMARY KEY("chat_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "core"."chat_settings" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."processed_updates" (
	"bot_id" text NOT NULL,
	"update_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_updates_bot_id_update_id_pk" PRIMARY KEY("bot_id","update_id")
);
--> statement-breakpoint
CREATE TABLE "core"."release_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"release_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"language_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."chat_module_states" ADD CONSTRAINT "chat_module_states_chat_id_telegram_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."chat_settings" ADD CONSTRAINT "chat_settings_chat_id_telegram_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."release_announcements" ADD CONSTRAINT "release_announcements_chat_id_telegram_chats_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."telegram_chats"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processed_updates_processed_at_idx" ON "core"."processed_updates" USING btree ("processed_at");