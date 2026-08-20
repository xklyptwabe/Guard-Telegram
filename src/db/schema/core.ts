import { boolean, index, integer, jsonb, pgSchema, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export const telegramChats = pgTable('telegram_chats', {
  chatId: text('chat_id').primaryKey(),
  type: text('type').notNull(),
  title: text('title'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const telegramUsers = pgTable('telegram_users', {
  userId: text('user_id').primaryKey(),
  languageCode: text('language_code'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const coreSchema = pgSchema('core');

export const chatSettings = coreSchema.table('chat_settings', {
  chatId: text('chat_id')
    .primaryKey()
    .references(() => telegramChats.chatId, { onDelete: 'cascade' }),
  locale: text('locale').notNull().default('ru'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const chatModuleStates = coreSchema.table(
  'chat_module_states',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => telegramChats.chatId, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.moduleId] })],
);

export const processedUpdates = coreSchema.table(
  'processed_updates',
  {
    botId: text('bot_id').notNull(),
    updateId: text('update_id').notNull(),
    /**
     * BOTS-9 review finding (BLOCKER-5): durable inbox state machine —
     * `received` → `processing` → `completed`, with `failed` awaiting
     * redelivery (the raw update is never stored, so only Telegram's own
     * redelivery can drive a retry; see migration 0017). A row is only a
     * dedup marker once it reads `completed` — anything else means
     * processing never finished and a redelivered update MUST be
     * reprocessed, not skipped.
     */
    status: text('status', { enum: ['received', 'processing', 'completed', 'failed'] }).notNull().default('received'),
    attemptCount: integer('attempt_count').notNull().default(0),
    workerId: text('worker_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: jsonb('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.updateId] }),
    index('processed_updates_processed_at_idx').on(table.processedAt),
    index('processed_updates_status_lease_idx').on(table.status, table.leaseExpiresAt),
  ],
);

export const consumedEnvelopes = coreSchema.table(
  'consumed_envelopes',
  {
    envelopeId: text('envelope_id').primaryKey(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('consumed_envelopes_consumed_at_idx').on(table.consumedAt)],
);

export const releaseAnnouncements = coreSchema.table('release_announcements', {
  id: uuid('id').defaultRandom().primaryKey(),
  chatId: text('chat_id')
    .notNull()
    .references(() => telegramChats.chatId, { onDelete: 'cascade' }),
  releaseId: text('release_id').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
