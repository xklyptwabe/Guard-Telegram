import { eq } from 'drizzle-orm';

import type { DrizzleDatabase } from '../db/client.js';
import { chatSettings } from '../db/schema/core.js';
import { AuditEventProcessor } from './audit/eventProcessor.js';
import { toDownstreamMutationResult } from './audit/serviceAdapter.js';
import { observed, notObserved } from './audit/snapshot.js';
import type { AuditService } from './auditService.js';
import { getUpdateContext } from './context.js';

export class MissingChatSettingsAuditIdempotencyKeyError extends Error {
  public constructor() {
    super('ChatSettingsService.setLocale requires an update context or explicit audit idempotency key.');
    this.name = 'MissingChatSettingsAuditIdempotencyKeyError';
  }
}

/**
 * BOTS-9: `chat.settings.changed` was a defined-but-never-produced audit
 * event (BOTS-7 scaffolding with no writer). This is the first real trigger
 * for it — currently just `locale`, `chat_settings`' only column today.
 * Mirrors `ModuleRegistry.setEnabled`'s pattern exactly: hand-built
 * `AuditEventInput` identity (tenantId = chatId, subjectType
 * 'chat_settings'), and the actual row write + BOTS-7 processor call happen
 * together inside `mutate`, both protected by the same `FOR UPDATE` lock
 * `AuditService.recordEntityChange` already takes on the entity snapshot
 * row.
 */
export class ChatSettingsService {
  private readonly auditProcessor = new AuditEventProcessor();

  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly audit: AuditService,
  ) {}

  public async getLocale(chatId: string): Promise<string | undefined> {
    const rows = await this.db.select({ locale: chatSettings.locale }).from(chatSettings).where(eq(chatSettings.chatId, chatId)).limit(1);
    return rows[0]?.locale;
  }

  public async setLocale(chatId: string, locale: string, actorId?: string, idempotencyKeyOverride?: string): Promise<void> {
    const context = getUpdateContext();
    const idempotencyKey = idempotencyKeyOverride ?? (context ? `chat.settings.changed:telegram-update:${context.botId ?? 'unscoped-bot'}:${context.updateId}:${chatId}` : undefined);
    if (!idempotencyKey) throw new MissingChatSettingsAuditIdempotencyKeyError();

    const result = await this.audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType: 'chat_settings',
        subjectId: chatId,
        eventType: 'chat.settings.changed',
        eventVersion: 'v1',
        category: 'chat',
        source: 'telegram.command',
        idempotencyKey,
        ...(actorId !== undefined ? { actorId, actorType: 'telegram_user' } : {}),
      },
      async (tx) => {
        const current = await tx.select({ locale: chatSettings.locale }).from(chatSettings).where(eq(chatSettings.chatId, chatId)).limit(1).for('update');
        const beforeLocale = current[0]?.locale;
        const now = new Date();
        await tx
          .insert(chatSettings)
          .values({ chatId, locale, updatedAt: now })
          .onConflictDoUpdate({ target: chatSettings.chatId, set: { locale, updatedAt: now } });

        // BOTS-7: after comes from the row that actually landed, not the
        // argument we intended to write. Missing previous row is
        // not_observed — never a fabricated default locale.
        const persisted = await tx.select({ locale: chatSettings.locale }).from(chatSettings).where(eq(chatSettings.chatId, chatId)).limit(1);
        const afterLocale = persisted[0]?.locale;
        if (afterLocale === undefined) throw new Error('chat.settings row missing after write');

        const operation = beforeLocale === afterLocale ? 'noop' : 'update';
        const record = this.auditProcessor.process({
          name: 'chat.settings.changed',
          version: 1,
          operation,
          chatId,
          ...(actorId !== undefined ? { actorId } : {}),
          before: beforeLocale !== undefined ? observed({ chatId, locale: beforeLocale }) : notObserved(),
          after: observed({ chatId, locale: afterLocale }),
        });
        const mutationResult = toDownstreamMutationResult(record);

        return { ...mutationResult, metadata: { operation }, snapshotStatus: mutationResult.snapshotStatus, snapshotData: mutationResult.snapshotData };
      },
    );
    void result;
  }
}
