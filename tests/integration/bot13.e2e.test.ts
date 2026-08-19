import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { CommandDispatcher } from '../../src/core/dispatcher.js';
import { ModuleRegistry } from '../../src/core/registry.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { chatModuleStates, telegramChats } from '../../src/db/schema/core.js';
import { entitySnapshots, events } from '../../src/db/schema/audit.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import { recordMemberStatusChanged } from '../../src/lib/audit/memberAudit.js';
import { AuditService } from '../../src/lib/auditService.js';
import { Cooldowns } from '../../src/lib/cooldowns.js';
import { EventBus } from '../../src/lib/eventBus.js';
import { initializeI18n } from '../../src/i18n/index.js';
import type { Logger } from '../../src/lib/logger.js';
import { ModerationService } from '../../src/lib/moderation/moderationService.js';
import { PendingOperationResolvers, PendingOperationsOutbox } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import { ReplyService } from '../../src/lib/reply.js';
import { createModules } from '../../src/modules/index.js';
import { ChatSettingsService } from '../../src/lib/chatSettings.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function silentLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeBot() {
  return {
    api: {
      raw: {
        banChatMember: vi.fn(async () => true),
        unbanChatMember: vi.fn(async () => true),
        restrictChatMember: vi.fn(async () => true),
        deleteMessage: vi.fn(async () => true),
      },
    },
  };
}

/**
 * BOT-13: полное интеграционное и сквозное тестирование бот-контура
 * (миграции, атомарность, rollback, конкурентность, Telegram Update,
 * outbox, 25 параллельных обработчиков, объём истории, снимки) —
 * против ОТДЕЛЬНОЙ, реальной БД (`TEST_DATABASE_URL`).
 *
 * Часть объёма BOT-13 (API-фильтры, cursor pagination, tenant-изоляция на
 * уровне backend API, отображение site-visible событий на сайте, полный
 * сценарий Telegram/сайт → PostgreSQL → API → сайт) требует репозиториев
 * backend/сайта, которых нет в этой кодовой базе — см. отчёт приёмки
 * `docs/bot-13-acceptance-report.md`.
 */
describe.skipIf(!testDatabaseUrl)('BOT-13: full integration scenarios', () => {
  let client: DatabaseClient;
  let audit: AuditService;

  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'bot13-test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    client = createDatabase(config);
    audit = new AuditService(client.db);
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    // Изоляция между тестами: чистим только то, что сами пишем, не трогая
    // seed-данные (audit.event_types / audit.event_policies с chat_id IS
    // NULL), которые накатили миграции.
    await client.db.execute(sql`DELETE FROM audit.events`);
    await client.db.execute(sql`DELETE FROM audit.entity_snapshots`);
    await client.db.execute(sql`DELETE FROM audit.outbox`);
    await client.db.execute(sql`DELETE FROM moderation.pending_operations`);
    await client.db.execute(sql`DELETE FROM core.processed_updates`);
    await client.db.execute(sql`DELETE FROM audit.event_policies WHERE chat_id IS NOT NULL`);
    // Parallel suites (bots9.fixes) may flip a global policy; restore defaults
    // so a GrammyError ban still has a writable mandatory moderation.action.
    await client.db.execute(sql`UPDATE audit.event_policies SET enabled = true WHERE chat_id IS NULL`);
    await client.db.execute(sql`DELETE FROM core.chat_module_states`);
    await client.db.execute(sql`DELETE FROM public.telegram_chats`);
  });

  describe('конкурентное изменение одной сущности', () => {
    it('две одновременные записи для одного subject сериализуются (FOR UPDATE), не теряют друг друга, и снимок отражает реально последнюю зафиксированную', async () => {
      const chatId = `concurrent-${randomUUID()}`;
      const subjectId = `${chatId}:999`;

      const write = (statusValue: string, idempotencyKey: string) =>
        audit.recordEntityChange(
          {
            tenantId: chatId,
            subjectType: 'chat_member',
            subjectId,
            eventType: 'member.status.changed',
            eventVersion: 'v1',
            category: 'member',
            source: 'test',
            idempotencyKey,
          },
          async () => ({
            before: { chatId, userId: '999', status: 'member' },
            after: { chatId, userId: '999', status: statusValue },
            beforeSnapshotStatus: 'observed' as const,
            afterSnapshotStatus: 'observed' as const,
            changes: { status: 'unavailable' as const, reason: 'ok' as const },
            metadata: { operation: 'update' },
            snapshotStatus: 'current' as const,
            snapshotData: { chatId, userId: '999', status: statusValue },
          }),
        );

      // Две гонки на один и тот же subject — разные idempotencyKey (две
      // РАЗНЫЕ логические операции), не редеплой одной и той же.
      const [resultA, resultB] = await Promise.all([write('administrator', `race-a-${randomUUID()}`), write('restricted', `race-b-${randomUUID()}`)]);

      expect(resultA.duplicate).toBe(false);
      expect(resultB.duplicate).toBe(false);

      const rows = await client.db.select().from(events).where(eq(events.subjectId, subjectId));
      expect(rows).toHaveLength(2);
      // FOR UPDATE гарантирует последовательные, не совпадающие sequence.
      const sequences = rows.map((r) => r.subjectSequence).sort((a, b) => a - b);
      expect(sequences).toEqual([1, 2]);
      expect(new Set(sequences).size).toBe(2); // ни один не потерян/не задвоен

      // Кто реально зафиксировался вторым (subjectSequence=2) — тот и
      // должен быть в снимке; не важно, кто из двух Promise.all-веток
      // стартовал раньше в коде.
      const winnerRow = rows.find((r) => r.subjectSequence === 2);
      const winnerStatus = (winnerRow?.after as { status: string } | null)?.status;
      expect(['administrator', 'restricted']).toContain(winnerStatus);

      const snapshot = await client.db.select().from(entitySnapshots).where(and(eq(entitySnapshots.entityType, 'chat_member'), eq(entitySnapshots.entityId, subjectId)));
      expect(snapshot).toHaveLength(1);
      expect((snapshot[0]?.snapshotData as { status: string }).status).toBe(winnerStatus); // снимок = реально последняя зафиксированная запись, не гонка в коде
    });
  });

  describe('повторные и пришедшие не по порядку Telegram Update', () => {
    it('повторно доставленный Update (тот же update_id) не создаёт дубль события — реальная БД, реальный producer, реальная fixture', async () => {
      const chatId = `dup-${randomUUID()}`;
      const telegramChatId = Number(chatId.replace(/\D/g, '') || '111');
      const ctx = {
        chatMember: {
          chat: { id: telegramChatId },
          from: { id: 9 },
          date: 1_770_000_000,
          old_chat_member: { status: 'member', user: { id: 222 } },
          new_chat_member: { status: 'administrator', user: { id: 222 } },
        },
      } as never;
      const updateId = `dup-update-${randomUUID()}`;

      await runWithUpdateContext({ updateId, chatId }, () => recordMemberStatusChanged(audit, silentLogger(), ctx));
      // Точно тот же Update приходит повторно (ретрай Telegram / webhook redelivery).
      await runWithUpdateContext({ updateId, chatId }, () => recordMemberStatusChanged(audit, silentLogger(), ctx));

      const rows = await client.db.select().from(events).where(eq(events.idempotencyKey, `member.status.changed:telegram-update:unscoped-bot:${updateId}:${String(telegramChatId)}:222`));
      expect(rows).toHaveLength(1); // не 2
    });

    it('пришедший не по порядку (более старый) Update не регрессирует текущий снимок в реальной БД', async () => {
      const rawChatId = `-${Math.floor(Math.random() * 1_000_000_000)}`;
      const numericChatId = Number(rawChatId);
      const chatId = String(numericChatId);
      const userId = '222';

      const newerCtx = {
        chatMember: { chat: { id: numericChatId }, from: { id: 9 }, date: 2_000_000_000, old_chat_member: { status: 'member', user: { id: 222 } }, new_chat_member: { status: 'kicked', user: { id: 222 } } },
      } as never;
      const olderCtx = {
        chatMember: { chat: { id: numericChatId }, from: { id: 9 }, date: 1_000_000_000, old_chat_member: { status: 'member', user: { id: 222 } }, new_chat_member: { status: 'administrator', user: { id: 222 } } },
      } as never;

      // Более новое событие (по Telegram date) обрабатывается первым...
      await runWithUpdateContext({ updateId: `order-new-${randomUUID()}`, chatId }, () => recordMemberStatusChanged(audit, silentLogger(), newerCtx));
      // ...затем прилетает более старое (сеть/ретраи доставили не по порядку).
      await runWithUpdateContext({ updateId: `order-old-${randomUUID()}`, chatId }, () => recordMemberStatusChanged(audit, silentLogger(), olderCtx));

      const subjectId = `${chatId}:${userId}`;
      const snapshot = await client.db.select().from(entitySnapshots).where(and(eq(entitySnapshots.entityType, 'chat_member'), eq(entitySnapshots.entityId, subjectId)));
      expect((snapshot[0]?.snapshotData as { status: string }).status).toBe('kicked'); // не регрессировал на 'administrator'

      const rows = await client.db.select().from(events).where(eq(events.subjectId, subjectId));
      expect(rows).toHaveLength(2); // оба всё равно аудированы для полной истории
    });
  });

  describe('ошибка и таймаут Telegram API — реальная БД, реальный outbox', () => {
    it('подтверждённая ошибка (GrammyError) пишет status=failed в реальную moderation.pending_operations и ровно одну запись в audit.events', async () => {
      const resolvers = new PendingOperationResolvers();
      const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
      const bot = fakeBot();
      bot.api.raw.banChatMember.mockRejectedValueOnce(new GrammyError('Bad Request: not enough rights', { ok: false, error_code: 400, description: 'Bad Request: not enough rights' } as never, 'banChatMember', {}));
      const moderation = new ModerationService(bot as never, audit, outbox, resolvers, silentLogger());
      const chatId = `err-${randomUUID()}`;

      const outcome = await runWithUpdateContext({ updateId: `err-${randomUUID()}`, chatId }, () => moderation.ban({ chatId, targetUserId: '2', actorUserId: '9' }));

      expect(outcome.status).toBe('failed');
      const rows = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('failed');

      const auditRows = await client.db.select().from(events).where(eq(events.eventType, 'moderation.action'));
      const forThisChat = auditRows.filter((r) => r.tenantId === chatId);
      expect(forThisChat).toHaveLength(1);
      expect((forThisChat[0]?.metadata as { operation: string }).operation).toBe('failed');
    });

    it('неподтверждённая ошибка (таймаут) пишет status=unknown, а не failed — и НЕ создаёт audit-запись, пока есть попытки в запасе', async () => {
      const resolvers = new PendingOperationResolvers();
      const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers, 5, 20); // 20ms таймаут
      const bot = fakeBot();
      bot.api.raw.banChatMember.mockImplementationOnce(() => new Promise(() => undefined)); // никогда не резолвится
      const moderation = new ModerationService(bot as never, audit, outbox, resolvers, silentLogger());
      const chatId = `timeout-${randomUUID()}`;

      const outcome = await runWithUpdateContext({ updateId: `timeout-${randomUUID()}`, chatId }, () => moderation.ban({ chatId, targetUserId: '2', actorUserId: '9' }));

      expect(outcome.status).toBe('unknown');
      const rows = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
      expect(rows[0]?.status).toBe('unknown');
      expect(rows[0]?.nextAttemptAt).not.toBeNull(); // запланирован повтор

      const auditRows = await client.db.select().from(events).where(eq(events.eventType, 'moderation.action'));
      expect(auditRows.filter((r) => r.tenantId === chatId)).toHaveLength(0); // ещё не итог
    });
  });

  describe('восстановление outbox после рестарта — реальная БД, новый процесс-эмулятор', () => {
    it('строка, зависшая in_progress из-за "падения процесса", дожимается СВЕЖИМ ModerationService (новые resolvers/outbox — как после реального рестарта)', async () => {
      const chatId = `restart-${randomUUID()}`;
      // Симулируем состояние на диске после падения: строка уже "заявлена"
      // (in_progress), но ни один процесс её больше не ведёт — ровно то,
      // что происходит при падении/перезапуске бота во время операции.
      await client.db.insert(pendingOperations).values({
        kind: 'telegram.banChatMember',
        chatId,
        requestPayload: { chat_id: -1, user_id: 2 },
        metadata: { action: 'ban', actorUserId: '9', targetUserId: '2' },
        idempotencyKey: `moderation.action:telegram-update:restart-1:${chatId}:2:ban`,
        status: 'in_progress',
        attemptCount: 1,
      });

      // "Новый процесс": свежие resolvers/outbox/ModerationService, тот же
      // реальный DB-коннекшн (единственное, что переживает рестарт).
      const resolvers2 = new PendingOperationResolvers();
      const outbox2 = new PendingOperationsOutbox(client.db, silentLogger(), resolvers2);
      const bot2 = fakeBot();
      const moderation2 = new ModerationService(bot2 as never, audit, outbox2, resolvers2, silentLogger());

      await moderation2.recoverPending();

      expect(bot2.api.raw.banChatMember).toHaveBeenCalledTimes(1);
      const rows = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
      expect(rows[0]?.status).toBe('succeeded');

      const auditRows = await client.db.select().from(events).where(eq(events.eventType, 'moderation.action'));
      expect(auditRows.filter((r) => r.tenantId === chatId)).toHaveLength(1); // ровно одна итоговая запись, дописанная после рестарта
    });
  });

  describe('25 параллельных обработчиков', () => {
    it('25 одновременных операций (разные сущности) — ни одна не потеряна, ни одна не задвоена, без дедлоков', async () => {
      const runId = randomUUID();
      const tasks = Array.from({ length: 25 }, (_, i) =>
        runWithUpdateContext({ updateId: `parallel-${runId}-${i}`, chatId: `parallel-chat-${i}` }, () =>
          audit.recordEntityChange(
            {
              tenantId: `parallel-chat-${i}`,
              subjectType: 'chat_member',
              subjectId: `parallel-chat-${i}:${i}`,
              eventType: 'member.status.changed',
              eventVersion: 'v1',
              category: 'member',
              source: 'test',
              idempotencyKey: `parallel-${runId}-${i}`,
            },
            async () => ({
              before: { chatId: `parallel-chat-${i}`, userId: String(i), status: 'member' },
              after: { chatId: `parallel-chat-${i}`, userId: String(i), status: 'administrator' },
              beforeSnapshotStatus: 'observed' as const,
              afterSnapshotStatus: 'observed' as const,
              changes: { status: 'unavailable' as const, reason: 'ok' as const },
              metadata: { operation: 'update' },
              snapshotStatus: 'current' as const,
              snapshotData: { chatId: `parallel-chat-${i}`, userId: String(i), status: 'administrator' },
            }),
          ),
        ),
      );

      const results = await Promise.all(tasks);
      expect(results.every((r) => r.duplicate === false)).toBe(true);

      const rows = await client.db.select().from(events).where(sql`${events.idempotencyKey} LIKE ${'parallel-' + runId + '-%'}`);
      expect(rows).toHaveLength(25); // ни одной потери, ни одного дубля
      expect(new Set(rows.map((r) => r.id)).size).toBe(25);
    });
  });

  describe('большой объём истории', () => {
    it('500 последовательных изменений одной сущности — все сохранены, subjectSequence монотонно возрастает без пропусков, снимок соответствует последнему', async () => {
      const chatId = `history-${randomUUID()}`;
      const subjectId = `${chatId}:777`;
      const total = 500;
      // Реальная схема member.status.changed — закрытый enum статусов
      // Telegram, а не произвольные строки; используем реальные значения,
      // а не выдуманные.
      const statuses = ['member', 'administrator', 'restricted', 'left', 'kicked'] as const;
      const statusAt = (i: number) => statuses[i % statuses.length]!;

      for (let i = 0; i < total; i += 1) {
        await audit.recordEntityChange(
          {
            tenantId: chatId,
            subjectType: 'chat_member',
            subjectId,
            eventType: 'member.status.changed',
            eventVersion: 'v1',
            category: 'member',
            source: 'test',
            idempotencyKey: `history-${chatId}-${i}`,
          },
          async () => ({
            before: { chatId, userId: '777', status: i === 0 ? 'member' : statusAt(i - 1) },
            after: { chatId, userId: '777', status: statusAt(i) },
            beforeSnapshotStatus: 'observed' as const,
            afterSnapshotStatus: 'observed' as const,
            changes: { status: 'unavailable' as const, reason: 'ok' as const },
            metadata: { operation: 'update' },
            snapshotStatus: 'current' as const,
            snapshotData: { chatId, userId: '777', status: statusAt(i) },
          }),
        );
      }

      const rows = await client.db.select({ seq: events.subjectSequence }).from(events).where(eq(events.subjectId, subjectId));
      const sequences = rows.map((r) => r.seq).sort((a, b) => a - b);
      expect(sequences).toHaveLength(total);
      expect(sequences[0]).toBe(1);
      expect(sequences[total - 1]).toBe(total);
      // Монотонно возрастает без пропусков.
      for (let i = 1; i < sequences.length; i += 1) expect(sequences[i]).toBe(sequences[i - 1]! + 1);

      const snapshot = await client.db.select().from(entitySnapshots).where(and(eq(entitySnapshots.entityType, 'chat_member'), eq(entitySnapshots.entityId, subjectId)));
      expect((snapshot[0]?.snapshotData as { status: string }).status).toBe(statusAt(total - 1));
    }, 30_000);
  });

  describe('большие и потенциально опасные (XSS-подобные) JSON-снимки', () => {
    it('текст с HTML/script-тегами сохраняется В ТОЧНОСТИ как есть — экранирование не задача этого слоя, а задача сайта на выводе', async () => {
      const chatId = `xss-${randomUUID()}`;
      const messageId = '555';
      const malicious = '<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';
      const editedAt = new Date().toISOString();

      await audit.recordEntityChange(
        {
          tenantId: chatId,
          subjectType: 'message',
          subjectId: `${chatId}:${messageId}`,
          eventType: 'message.edited',
          eventVersion: 'v1',
          category: 'message',
          source: 'test',
          idempotencyKey: `xss-${randomUUID()}`,
          auditPolicy: { allowMessageTextLogging: true }, // симулируем чат, где админ явно включил полный аудит текста сообщений
        },
        async () => ({
          before: undefined,
          after: { chatId, messageId, userId: '1', editedAt, textLength: malicious.length, text: malicious },
          beforeSnapshotStatus: 'not_observed' as const,
          afterSnapshotStatus: 'observed' as const,
          changes: { status: 'unavailable' as const, reason: 'ok' as const },
          metadata: { operation: 'create' },
          snapshotStatus: 'current' as const,
          snapshotData: { chatId, messageId, userId: '1', editedAt, textLength: malicious.length, text: malicious },
        }),
      );

      const rows = await client.db.select().from(events).where(eq(events.subjectId, `${chatId}:${messageId}`));
      expect((rows[0]?.after as { text: string }).text).toBe(malicious); // байт-в-байт, не изменено/не заэкранировано на этом уровне
    });

    it('снимок с текстом РОВНО на границе (4096 символов — реальный максимум длины сообщения в Telegram) сохраняется без обрезки', async () => {
      const chatId = `bigjson-${randomUUID()}`;
      const messageId = '556';
      const maxText = 'A'.repeat(4096);
      const editedAt = new Date().toISOString();

      await audit.recordEntityChange(
        {
          tenantId: chatId,
          subjectType: 'message',
          subjectId: `${chatId}:${messageId}`,
          eventType: 'message.edited',
          eventVersion: 'v1',
          category: 'message',
          source: 'test',
          idempotencyKey: `bigjson-${randomUUID()}`,
          auditPolicy: { allowMessageTextLogging: true },
        },
        async () => ({
          before: undefined,
          after: { chatId, messageId, userId: '1', editedAt, textLength: maxText.length, text: maxText },
          beforeSnapshotStatus: 'not_observed' as const,
          afterSnapshotStatus: 'observed' as const,
          changes: { status: 'unavailable' as const, reason: 'ok' as const },
          metadata: { operation: 'create' },
          snapshotStatus: 'current' as const,
          snapshotData: { chatId, messageId, userId: '1', editedAt, textLength: maxText.length, text: maxText },
        }),
      );

      const snapshot = await client.db.select().from(entitySnapshots).where(and(eq(entitySnapshots.entityType, 'message'), eq(entitySnapshots.entityId, `${chatId}:${messageId}`)));
      expect((snapshot[0]?.snapshotData as { text: string }).text).toHaveLength(4096);
      expect((snapshot[0]?.snapshotData as { text: string }).text).toBe(maxText);
    });

    it('снимок с текстом ЗА границей (4097+ символов) корректно ОТКЛОНЯЕТСЯ схемой, а не обрезается/повреждается молча', async () => {
      const chatId = `bigjson-over-${randomUUID()}`;
      const messageId = '557';
      const overLimitText = 'A'.repeat(4097);
      const editedAt = new Date().toISOString();

      await expect(
        audit.recordEntityChange(
          {
            tenantId: chatId,
            subjectType: 'message',
            subjectId: `${chatId}:${messageId}`,
            eventType: 'message.edited',
            eventVersion: 'v1',
            category: 'message',
            source: 'test',
            idempotencyKey: `bigjson-over-${randomUUID()}`,
            auditPolicy: { allowMessageTextLogging: true },
          },
          async () => ({
            before: undefined,
            after: { chatId, messageId, userId: '1', editedAt, textLength: overLimitText.length, text: overLimitText },
            beforeSnapshotStatus: 'not_observed' as const,
            afterSnapshotStatus: 'observed' as const,
            changes: { status: 'unavailable' as const, reason: 'ok' as const },
            metadata: { operation: 'create' },
            snapshotStatus: 'current' as const,
            snapshotData: { chatId, messageId, userId: '1', editedAt, textLength: overLimitText.length, text: overLimitText },
          }),
        ),
      ).rejects.toThrow(/at most 4096/);

      // Ничего не должно было записаться — вся транзакция откатилась.
      const rows = await client.db.select().from(events).where(eq(events.subjectId, `${chatId}:${messageId}`));
      expect(rows).toHaveLength(0);
    });
  });

  describe('права доступа — отрицательные сценарии, реальный CommandDispatcher + ModuleRegistry', () => {
    async function buildDispatcher(chatId: string) {
      const audit2 = new AuditService(client.db);
      const chatSettings = new ChatSettingsService(client.db, audit2);
      const resolvers = new PendingOperationResolvers();
      const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
      const bot = fakeBot();
      const moderation = new ModerationService(bot as never, audit2, outbox, resolvers, silentLogger());
      const modules = createModules({ audit: audit2, logger: silentLogger(), chatSettings, moderation });
      const events2 = new EventBus(silentLogger());
      const registry = new ModuleRegistry(modules, client.db, audit2, events2, silentLogger());
      const config = validateConfig({ TELEGRAM_BOT_TOKEN: 'x', DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test', DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true', TELEGRAM_TOPIC_FALLBACK_TO_CHAT: 'false' });
      const reply = new ReplyService(config, silentLogger());
      const i18n = await initializeI18n();
      const dispatcher = new CommandDispatcher(
        modules.flatMap((m) => m.commands ?? []),
        registry,
        new Cooldowns(),
        reply,
        events2,
        i18n,
        silentLogger(),
        audit2,
      );

      // Чат + moderation-модуль включён (по умолчанию выключен — реалистичный сетап "админ уже включил модуль").
      await client.db.insert(telegramChats).values({ chatId, type: 'supergroup' });
      await client.db.insert(chatModuleStates).values({ chatId, moduleId: 'moderation', enabled: true });

      return { dispatcher, moderation, bot };
    }

    function fakeCtxForCommand(chatId: string, userId: string, memberStatus: 'member' | 'administrator', sentMessages: string[]) {
      const message = { message_id: 1, chat: { id: Number(chatId), type: 'supergroup' }, reply_to_message: { from: { id: 999 } } };
      return {
        chat: { id: Number(chatId), type: 'supergroup' },
        from: { id: Number(userId), is_bot: false, first_name: 'Test' },
        message,
        update: { update_id: 1, message },
        api: {
          getChatMember: vi.fn(async () => ({ status: memberStatus })),
          sendMessage: vi.fn(async (_chatId: unknown, text: string) => {
            sentMessages.push(text);
            return {};
          }),
        },
      } as unknown as never;
    }

    it('обычный участник (не админ) НЕ может выполнить /ban — ModerationService не вызывается, пользователь получает отказ', async () => {
      const chatId = String(-500_000_000 - Math.floor(Math.random() * 1_000_000));
      const { dispatcher, bot } = await buildDispatcher(chatId);
      const sent: string[] = [];
      const ctx = fakeCtxForCommand(chatId, '111', 'member', sent); // НЕ администратор

      await runWithUpdateContext({ updateId: `perm-${randomUUID()}`, chatId }, () => dispatcher.dispatchCommand(ctx, 'ban', 'test reason'));

      expect(bot.api.raw.banChatMember).not.toHaveBeenCalled(); // не дошло даже до внешнего вызова
      const rows = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
      expect(rows).toHaveLength(0); // ни одна внешняя операция не была запущена
      expect(sent.some((s) => s.length > 0)).toBe(true); // получил какой-то ответ (отказ)
    });

    it('администратор чата МОЖЕТ выполнить /ban — доходит до ModerationService и реального вызова Telegram API', async () => {
      const chatId = String(-600_000_000 - Math.floor(Math.random() * 1_000_000));
      const { dispatcher, bot } = await buildDispatcher(chatId);
      const sent: string[] = [];
      const ctx = fakeCtxForCommand(chatId, '111', 'administrator', sent);

      await runWithUpdateContext({ updateId: `perm-${randomUUID()}`, chatId }, () => dispatcher.dispatchCommand(ctx, 'ban', 'test reason'));

      expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1); // реально дошло до внешнего вызова
      const rows = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
      expect(rows).toHaveLength(1);
    });

    it('выключенный в чате модуль блокирует команду ещё до проверки прав — тоже отрицательный сценарий', async () => {
      const chatId = String(-700_000_000 - Math.floor(Math.random() * 1_000_000));
      const { dispatcher, bot } = await buildDispatcher(chatId);
      await client.db.update(chatModuleStates).set({ enabled: false }).where(eq(chatModuleStates.chatId, chatId));
      const sent: string[] = [];
      const ctx = fakeCtxForCommand(chatId, '111', 'administrator', sent); // даже админ

      await runWithUpdateContext({ updateId: `perm-${randomUUID()}`, chatId }, () => dispatcher.dispatchCommand(ctx, 'ban', 'test reason'));

      expect(bot.api.raw.banChatMember).not.toHaveBeenCalled();
    });
  });

  describe('tenant-изоляция', () => {
    it('один и тот же targetUserId в двух разных чатах — независимые снимки и истории, без утечки между чатами', async () => {
      const chatA = String(-800_000_000 - Math.floor(Math.random() * 1_000_000));
      const chatB = String(-900_000_000 - Math.floor(Math.random() * 1_000_000));
      const sharedUserId = 4242;

      const ctxFor = (chatId: string, status: string) =>
        ({
          chatMember: {
            chat: { id: Number(chatId) },
            from: { id: 9 },
            date: 1_770_000_000,
            old_chat_member: { status: 'member', user: { id: sharedUserId } },
            new_chat_member: { status, user: { id: sharedUserId } },
          },
        }) as never;

      await runWithUpdateContext({ updateId: `tenant-a-${randomUUID()}`, chatId: chatA }, () => recordMemberStatusChanged(audit, silentLogger(), ctxFor(chatA, 'administrator')));
      await runWithUpdateContext({ updateId: `tenant-b-${randomUUID()}`, chatId: chatB }, () => recordMemberStatusChanged(audit, silentLogger(), ctxFor(chatB, 'kicked')));

      const snapshotA = await client.db.select().from(entitySnapshots).where(and(eq(entitySnapshots.entityType, 'chat_member'), eq(entitySnapshots.entityId, `${chatA}:${sharedUserId}`)));
      const snapshotB = await client.db.select().from(entitySnapshots).where(and(eq(entitySnapshots.entityType, 'chat_member'), eq(entitySnapshots.entityId, `${chatB}:${sharedUserId}`)));

      expect((snapshotA[0]?.snapshotData as { status: string }).status).toBe('administrator');
      expect((snapshotB[0]?.snapshotData as { status: string }).status).toBe('kicked'); // не перезаписан статусом из чата A

      const eventsA = await client.db.select().from(events).where(eq(events.tenantId, chatA));
      const eventsB = await client.db.select().from(events).where(eq(events.tenantId, chatB));
      expect(eventsA.every((e) => e.tenantId === chatA)).toBe(true);
      expect(eventsB.every((e) => e.tenantId === chatB)).toBe(true);
      expect(eventsA.some((e) => e.subjectId?.startsWith(chatB))).toBe(false);
    });
  });
});
