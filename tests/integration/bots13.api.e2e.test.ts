import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateConfig, type AppConfig } from '../../src/config.js';
import { collectCommands, registerCommands } from '../../src/core/commandRegistrar.js';
import { CommandDispatcher } from '../../src/core/dispatcher.js';
import { ModuleRegistry } from '../../src/core/registry.js';
import { createTelegramBot } from '../../src/core/telegram.js';
import { registerBotMembershipAudit, registerModuleUpdateHandlers, registerPlatformMiddleware, startWebhook, type TransportController } from '../../src/core/updates.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { chatModuleStates, telegramChats } from '../../src/db/schema/core.js';
import { entitySnapshots, events, outbox } from '../../src/db/schema/audit.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import { startBackendApiServer, type BackendApiController } from '../../src/api/server.js';
import { AuditService } from '../../src/lib/auditService.js';
import { ChatSettingsService } from '../../src/lib/chatSettings.js';
import { Cooldowns } from '../../src/lib/cooldowns.js';
import { EventBus } from '../../src/lib/eventBus.js';
import { initializeI18n } from '../../src/i18n/index.js';
import type { Logger } from '../../src/lib/logger.js';
import { ModerationService } from '../../src/lib/moderation/moderationService.js';
import { PendingOperationResolvers, PendingOperationsOutbox } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import { ReplyService } from '../../src/lib/reply.js';
import { createModules } from '../../src/modules/index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const WEBHOOK_PORT = 18_301;
const API_PORT = 18_302;
const WEBHOOK_SECRET = 'bots13-e2e-webhook-secret';
const SITE_TOKEN = 'bots13-site-token-31337';
const ADMIN_TOKEN = 'bots13-admin-token-75757';
const NO_PERM_TOKEN = 'bots13-noperm-token-91191';

const CHAT_A = '-1003131313';
const CHAT_B = '-1003133131';

function silentLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

interface ApiEvent {
  readonly id: string;
  readonly eventType: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * BOTS-13 end-to-end: Telegram → PostgreSQL → backend API → сайт.
 *
 * The "Test contour" here is as real as this repository can make it: a real
 * webhook transport (HTTP server from src/core/updates.ts), the real grammy
 * middleware pipeline (inbox dedup → module handlers → dispatcher), a real
 * PostgreSQL at TEST_DATABASE_URL, and the real backend API server bound to
 * a real port and queried over real HTTP. Only the Telegram *network* is
 * stubbed — via an api transformer that answers Bot API calls locally, the
 * same seam grammy documents for testing.
 *
 * The сайт (frontend) itself lives in another repository; its data contract
 * is exactly this API (`GET /api/v1/audit/events`, site-visible only). What
 * this suite proves is the entire path up to that contract.
 */
describe.skipIf(!testDatabaseUrl)('BOTS-13 API end-to-end: Telegram → PostgreSQL → API → сайт', () => {
  let client: DatabaseClient;
  let audit: AuditService;
  let transport: TransportController | undefined;
  let backendApi: BackendApiController | undefined;
  let apiBase: string;

  const telegramCalls: string[] = [];
  const sentTexts: string[] = [];

  beforeAll(async () => {
    const config: AppConfig = validateConfig({
      TELEGRAM_BOT_TOKEN: '424242:bots13-e2e-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      TELEGRAM_TRANSPORT: 'webhook',
      TELEGRAM_ALLOWED_UPDATES: 'message,edited_message,callback_query,my_chat_member,chat_member',
      TELEGRAM_WEBHOOK_URL: 'https://bots13-e2e.invalid/webhook',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_WEBHOOK_PORT: String(WEBHOOK_PORT),
      BACKEND_API_ENABLED: 'true',
      BACKEND_API_HOST: '127.0.0.1',
      BACKEND_API_PORT: String(API_PORT),
      BACKEND_API_TOKENS: JSON.stringify([
        { token: SITE_TOKEN, actorId: 'bots13-site', permissions: ['audit.events.read'], allowedChatIds: [CHAT_A], systemAdmin: false },
        { token: ADMIN_TOKEN, actorId: 'bots13-admin', permissions: ['audit.events.read'], allowedChatIds: [], systemAdmin: true },
        { token: NO_PERM_TOKEN, actorId: 'bots13-noperm', permissions: [], allowedChatIds: [CHAT_A], systemAdmin: false },
      ]),
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    apiBase = `http://127.0.0.1:${API_PORT}`;

    client = createDatabase(config, silentLogger());
    audit = new AuditService(client.db);

    // --- The bot, wired exactly like src/index.ts bootstrap() ---
    const bot = createTelegramBot(config, silentLogger());
    // Local Telegram: answer every Bot API call without the network (the
    // documented grammy testing seam — a transformer that never hits the wire).
    const localTelegram = (method: string, payload?: { text?: string }): Promise<unknown> => {
      telegramCalls.push(method);
      if (method === 'sendMessage' && typeof payload?.text === 'string') sentTexts.push(payload.text);
      switch (method) {
        case 'getMe':
          return Promise.resolve({ ok: true, result: { id: 424242, is_bot: true, first_name: 'Bots13Bot', username: 'bots13_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } });
        case 'getChatMember':
          return Promise.resolve({ ok: true, result: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } });
        default:
          return Promise.resolve({ ok: true, result: true });
      }
    };
    bot.api.config.use(((prev: never, method: string, payload?: { text?: string }) => localTelegram(method, payload)) as never);
    await bot.init();

    const resolvers = new PendingOperationResolvers();
    const outboxWorker = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    const moderation = new ModerationService(bot as never, audit, outboxWorker, resolvers, silentLogger());
    const chatSettings = new ChatSettingsService(client.db, audit);
    const modules = createModules({ audit, logger: silentLogger(), chatSettings, moderation });
    const eventBus = new EventBus(silentLogger());
    const registry = new ModuleRegistry(modules, client.db, audit, eventBus, silentLogger());
    const reply = new ReplyService(config, silentLogger());
    const i18n = await initializeI18n();
    const dispatcher = new CommandDispatcher(collectCommands(modules), registry, new Cooldowns(), reply, eventBus, i18n, silentLogger(), audit);

    registerPlatformMiddleware(bot, client.db, registry, silentLogger());
    registerBotMembershipAudit(bot, audit, silentLogger());
    registerModuleUpdateHandlers(bot, modules, registry, silentLogger());
    await registerCommands(bot, modules, dispatcher, i18n, silentLogger());

    // moderation module is defaultEnabled=false — turn it on for CHAT_A like
    // a real admin would have, so /ban is reachable.
    await client.db.insert(telegramChats).values({ chatId: CHAT_A, type: 'supergroup' }).onConflictDoNothing();
    await client.db.insert(chatModuleStates).values({ chatId: CHAT_A, moduleId: 'moderation', enabled: true }).onConflictDoNothing();

    transport = await startWebhook(bot, config, silentLogger());
    backendApi = await startBackendApiServer(config, client.db, audit, silentLogger());
  });

  afterAll(async () => {
    await transport?.stop();
    await backendApi?.stop();
    await client.close();
  });

  beforeEach(async () => {
    await client.db.execute(sql`DELETE FROM audit.events`);
    await client.db.execute(sql`DELETE FROM audit.entity_snapshots`);
    await client.db.execute(sql`DELETE FROM audit.outbox`);
    await client.db.execute(sql`DELETE FROM moderation.pending_operations`);
    await client.db.execute(sql`DELETE FROM core.processed_updates`);
    await client.db.execute(sql`DELETE FROM audit.event_policies WHERE chat_id IS NOT NULL`);
    await client.db.execute(sql`DELETE FROM core.chat_module_states`);
    await client.db.execute(sql`DELETE FROM public.telegram_chats`);
    await client.db.insert(telegramChats).values({ chatId: CHAT_A, type: 'supergroup' }).onConflictDoNothing();
    await client.db.insert(chatModuleStates).values({ chatId: CHAT_A, moduleId: 'moderation', enabled: true }).onConflictDoNothing();
  });

  async function postUpdate(fixture: string): Promise<void> {
    const body = JSON.parse(await readFile(resolve('tests/fixtures/updates/bots13', fixture), 'utf8')) as unknown;
    const response = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  }

  function api(path: string, token: string | undefined): Promise<Response> {
    return fetch(`${apiBase}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  }

  async function listEvents(token: string, query = ''): Promise<readonly ApiEvent[]> {
    const response = await api(`/api/v1/audit/events${query}`, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: readonly ApiEvent[] };
    return body.items;
  }

  describe('сквозной сценарий: webhook-транспорт → PostgreSQL → API → сайт', () => {
    it('delivers real fixtures through the real webhook pipeline; the site principal sees exactly the site-visible set', async () => {
      await postUpdate('chat_member.promoted.json');
      await postUpdate('my_chat_member.kicked.json');
      await postUpdate('edited_message.json');
      await postUpdate('ban.command.json');
      await postUpdate('chat_member.other-chat.json');

      // --- PostgreSQL leg: every update produced its audit row ---
      const chatARows = await client.db.select().from(events).where(eq(events.tenantId, CHAT_A));
      const byType = new Map(chatARows.map((row) => [row.eventType, row]));
      expect([...byType.keys()].sort()).toEqual(['bot.membership.changed', 'command.executed', 'member.status.changed', 'message.edited', 'moderation.action']);
      expect(await client.db.select().from(events).where(eq(events.tenantId, CHAT_B))).toHaveLength(1);

      const memberEvent = byType.get('member.status.changed');
      expect((memberEvent?.before as { status: string } | null)?.status).toBe('member');
      expect((memberEvent?.after as { status: string })?.status).toBe('administrator');
      const botEvent = byType.get('bot.membership.changed');
      expect((botEvent?.after as { status: string })?.status).toBe('kicked');
      const moderationEvent = byType.get('moderation.action');
      expect((moderationEvent?.after as { action: string })?.action).toBe('ban');
      expect((moderationEvent?.after as { targetUserId: string })?.targetUserId).toBe('555001');
      // The write-ahead outbox row for the ban reached its terminal state.
      const [pending] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, CHAT_A));
      expect(pending?.status).toBe('succeeded');
      expect(pending?.auditStatus).toBe('written');
      expect(telegramCalls).toContain('banChatMember');

      // --- API leg (what the сайт consumes) ---
      const siteEvents = await listEvents(SITE_TOKEN);
      const siteTypes = siteEvents.map((event) => event.eventType).sort();
      expect(siteTypes).toEqual(['bot.membership.changed', 'command.executed', 'member.status.changed', 'moderation.action']); // message.edited is siteVisible=false by default
      expect(siteEvents.every((event) => event.tenantId === CHAT_A)).toBe(true); // chat B never leaks
      const siteMember = siteEvents.find((event) => event.eventType === 'member.status.changed');
      expect((siteMember?.after as { status: string })?.status).toBe('administrator');

      // GET by id agrees with the list for the site principal.
      const byId = await api(`/api/v1/audit/events/${siteMember!.id}`, SITE_TOKEN);
      expect(byId.status).toBe(200);
      expect(((await byId.json()) as { item: ApiEvent }).item.id).toBe(siteMember!.id);

      // The edited-message event exists in PostgreSQL but the site contract
      // (siteVisibleOnly, enforced for every principal — even systemAdmin)
      // never serves it: by id → 404, in list → absent.
      const editedRow = byType.get('message.edited');
      const editedResponse = await api(`/api/v1/audit/events/${editedRow!.id}`, SITE_TOKEN);
      expect(editedResponse.status).toBe(404);
      expect((await api(`/api/v1/audit/events/${editedRow!.id}`, ADMIN_TOKEN)).status).toBe(404);
      expect((await listEvents(ADMIN_TOKEN, '?eventType=message.edited'))).toEqual([]);
    }, 60_000);

    it('XSS-carrying payloads survive the full pipeline byte-for-byte, delivered as JSON only', async () => {
      // message.edited is siteVisible=false with text masked by default. A
      // chat admin opting IN via the per-chat policy override — the
      // documented mechanism — is what makes both the event and its text
      // site data. The override must exist BEFORE the update arrives:
      // masking is applied at write time, never retroactively.
      await client.db.execute(sql`
        INSERT INTO audit.event_policies (policy_id, chat_id, event_type, event_version, site_visible, allowlist)
        VALUES ('bots13-e2e-edited-visible', ${CHAT_A}, 'message.edited', 'v1', true, '["text"]'::jsonb)
      `);
      await postUpdate('edited_message.json');

      const rows = await client.db.select().from(events).where(eq(events.eventType, 'message.edited'));
      expect(rows).toHaveLength(1);
      expect((rows[0]!.after as { text?: string }).text).toBeDefined(); // the allowlist override actually un-masked text
      const response = await api('/api/v1/audit/events?eventType=message.edited', SITE_TOKEN);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8'); // never text/html — no sniffing surface
      const body = (await response.json()) as { items: readonly { after: { text?: string } }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.after.text).toBe((rows[0]!.after as { text: string }).text); // stored and served identically — escaping is the site's render-time job
      expect(body.items[0]!.after.text).toContain("<script>alert('bots13')</script>");
    });

    it('redelivering the same webhook update creates no second event (durable inbox across the transport)', async () => {
      await postUpdate('chat_member.promoted.json');
      await postUpdate('chat_member.promoted.json');
      await postUpdate('chat_member.promoted.json');

      const rows = await client.db.select().from(events).where(eq(events.eventType, 'member.status.changed'));
      expect(rows).toHaveLength(1);
      const snapshots = await client.db.select().from(entitySnapshots);
      expect(snapshots).toHaveLength(1);
      expect(await client.db.select().from(outbox)).toHaveLength(1);
    });

    it('module-admin self-disable lockout regression: the refusal is graceful and the chat keeps control', async () => {
      // Before the BOTS-13 bug-hunt fix, this command permanently locked a
      // chat out of module management: every /modules* command is owned by
      // the very module being disabled here.
      await postUpdate('module_disable.command.json');

      // The disable was refused: no override row, no state-change audit.
      const overrideRows = await client.db.select().from(chatModuleStates).where(eq(chatModuleStates.moduleId, 'module-admin'));
      expect(overrideRows).toHaveLength(0);
      const stateChange = await client.db.select().from(events).where(and(eq(events.eventType, 'module.state.changed'), eq(events.subjectId, `${CHAT_A}:module-admin`)));
      expect(stateChange).toHaveLength(0);

      // …and the admin got a meaningful refusal, not silence or an error.
      expect(sentTexts.some((text) => text.includes('module-admin'))).toBe(true);

      // The administration surface still works right after the attempt.
      // (command.executed subjectIds end with the command *name*: `…:modules`.)
      await postUpdate('modules.command.json');
      const executed = await client.db.select().from(events).where(and(eq(events.eventType, 'command.executed'), sql`${events.subjectId} LIKE ${'%:modules'}`));
      expect(executed).toHaveLength(1); // команда дошла до исполнения — lockout-а нет
    });
  });

  describe('разграничение прав — отрицательные сценарии через реальный HTTP', () => {
    it('rejects missing, malformed, and unknown credentials', async () => {
      expect((await api('/api/v1/audit/events', undefined)).status).toBe(401);
      expect((await api('/api/v1/audit/events', 'not-a-real-token-000000')).status).toBe(401);
      const basic = await fetch(`${apiBase}/api/v1/audit/events`, { headers: { authorization: 'Basic Zm9vOmJhcg==' } });
      expect(basic.status).toBe(401);
    });

    it('rejects a valid token without audit.events.read (403, not 404/500)', async () => {
      const response = await api('/api/v1/audit/events', NO_PERM_TOKEN);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    });

    it('tenant isolation: the site principal cannot read, list, or filter its way into chat B', async () => {
      await postUpdate('chat_member.promoted.json'); // chat A
      await postUpdate('chat_member.other-chat.json'); // chat B

      const listed = await listEvents(SITE_TOKEN);
      expect(listed.every((event) => event.tenantId === CHAT_A)).toBe(true);
      expect(listed.some((event) => event.tenantId === CHAT_B)).toBe(false);

      const [chatBEvent] = await client.db.select().from(events).where(eq(events.tenantId, CHAT_B));
      expect((await api(`/api/v1/audit/events/${chatBEvent!.id}`, SITE_TOKEN)).status).toBe(404); // exists, but not for this principal

      const filtered = await listEvents(SITE_TOKEN, `?chatId=${CHAT_B}`);
      expect(filtered).toEqual([]); // scope ∩ filter, never scope ∪ filter

      const adminSees = await listEvents(ADMIN_TOKEN, `?chatId=${CHAT_B}`);
      expect(adminSees).toHaveLength(1);
    });
  });

  describe('все API-фильтры и cursor pagination (реальная БД, реальный HTTP)', () => {
    const chatF = '-1003131414';
    const actorX = '600001';
    const correlation = 'bots13-filter-corr';

    interface SeedInput {
      readonly key: string;
      readonly eventType: string;
      readonly category: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly source: string;
      /** Event-schema-valid after snapshot (shapes.ts) — the API serves exactly what was stored. */
      readonly afterData: Record<string, unknown>;
      readonly actorId?: string;
      readonly correlationId?: string;
      readonly threadId?: string;
      readonly moduleId?: string;
      readonly status?: 'recorded' | 'failed';
    }

    async function seed(input: SeedInput): Promise<string> {
      if (input.status === 'failed') {
        // The audit service only writes 'recorded' events; a `failed` row is
        // the integration layer's shape — insert it directly, still through
        // the real table constraints. member.status.changed is site-visible
        // by default, so this row exercises the status filter via the API.
        const id = randomUUID();
        await client.db.execute(sql`
          INSERT INTO audit.events (id, event_type, event_version, category, occurred_at, source, status,
            tenant_id, actor_id, actor_type, subject_type, subject_id, idempotency_key, correlation_id,
            telegram_context, metadata, after, before_snapshot_status, after_snapshot_status)
          VALUES (${id}, ${input.eventType}, 'v1', ${input.category}, now(), ${input.source}, 'failed',
            ${chatF}, ${input.actorId ?? null}, 'integration', ${input.subjectType}, ${input.subjectId},
            ${input.key}, ${input.correlationId ?? null}, ${JSON.stringify(input.threadId ? { messageThreadId: input.threadId } : {})}::jsonb,
            ${JSON.stringify(input.moduleId ? { moduleId: input.moduleId } : {})}::jsonb,
            ${JSON.stringify(input.afterData)}::jsonb, 'not_observed', 'observed')
        `);
        return id;
      }
      await audit.recordEntityChange(
        {
          tenantId: chatF,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          eventType: input.eventType,
          eventVersion: 'v1',
          category: input.category,
          source: input.source,
          idempotencyKey: input.key,
          ...(input.actorId ? { actorId: input.actorId, actorType: 'telegram_user' } : {}),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          ...(input.moduleId ? { moduleId: input.moduleId } : {}),
          ...(input.threadId ? { telegramContext: { messageThreadId: input.threadId } } : {}),
        },
        async () => ({
          before: undefined,
          after: input.afterData,
          beforeSnapshotStatus: 'not_observed' as const,
          afterSnapshotStatus: 'observed' as const,
          snapshotStatus: 'current' as const,
          snapshotData: input.afterData,
        }),
      );
      return input.key;
    }

    const member1: SeedInput = { key: 'filter-member-1', eventType: 'member.status.changed', category: 'member', subjectType: 'chat_member', subjectId: `${chatF}:1`, source: 'telegram.chat_member_update', actorId: actorX, correlationId: correlation, threadId: '77', afterData: { chatId: chatF, userId: '1', status: 'administrator' } };
    const member2: SeedInput = { key: 'filter-member-2', eventType: 'member.status.changed', category: 'member', subjectType: 'chat_member', subjectId: `${chatF}:2`, source: 'telegram.chat_member_update', afterData: { chatId: chatF, userId: '2', status: 'member' } };
    const command1: SeedInput = { key: 'filter-command-1', eventType: 'command.executed', category: 'command', subjectType: 'command', subjectId: `${chatF}:ban:1`, source: 'telegram.command', actorId: '600002', moduleId: 'moderation', afterData: { chatId: chatF, userId: '600002', moduleId: 'moderation', commandId: 'moderation.ban', argsRedacted: true, durationMs: 12, success: true } };
    const command2: SeedInput = { key: 'filter-command-2', eventType: 'command.executed', category: 'command', subjectType: 'command', subjectId: `${chatF}:ban:2`, source: 'telegram.command', threadId: '88', afterData: { chatId: chatF, userId: '600003', moduleId: 'moderation', commandId: 'moderation.unban', argsRedacted: true, durationMs: 34, success: true } };
    const memberFailed: SeedInput = { key: 'filter-member-failed', eventType: 'member.status.changed', category: 'member', subjectType: 'chat_member', subjectId: `${chatF}:3`, source: 's3.upload', status: 'failed', actorId: actorX, afterData: { chatId: chatF, userId: '3', status: 'left' } };

    beforeEach(async () => {
      await seed(member1);
      await seed(member2);
      await seed(command1);
      await seed(command2);
      await seed(memberFailed);
    });

    it('filters by eventType (single and multi)', async () => {
      expect((await listEvents(ADMIN_TOKEN, '?eventType=member.status.changed')).map((event) => event.subjectId).sort()).toEqual([`${chatF}:1`, `${chatF}:2`, `${chatF}:3`]);
      expect((await listEvents(ADMIN_TOKEN, '?eventType=command.executed&eventType=member.status.changed')).map((event) => event.eventType).sort()).toEqual(['command.executed', 'command.executed', 'member.status.changed', 'member.status.changed', 'member.status.changed']);
    });

    it('filters by category and by status', async () => {
      expect((await listEvents(ADMIN_TOKEN, '?category=member')).map((event) => event.subjectId).sort()).toEqual([`${chatF}:1`, `${chatF}:2`, `${chatF}:3`]);
      expect((await listEvents(ADMIN_TOKEN, '?status=failed')).map((event) => event.subjectId)).toEqual([`${chatF}:3`]);
      expect((await listEvents(ADMIN_TOKEN, '?status=recorded&category=command')).length).toBe(2);
    });

    it('filters by source, subjectType, subjectId, actorId, correlationId', async () => {
      expect((await listEvents(ADMIN_TOKEN, '?source=telegram.command')).length).toBe(2);
      expect((await listEvents(ADMIN_TOKEN, `?subjectId=${chatF}:1`)).map((event) => event.eventType)).toEqual(['member.status.changed']);
      expect((await listEvents(ADMIN_TOKEN, '?subjectType=command&actorId=600002')).map((event) => event.subjectId)).toEqual([`${chatF}:ban:1`]);
      expect((await listEvents(ADMIN_TOKEN, `?correlationId=${correlation}`)).map((event) => event.subjectId)).toEqual([`${chatF}:1`]);
    });

    it('filters by topicId (JSONB telegram_context) and moduleId (JSONB metadata)', async () => {
      const byTopic = await listEvents(ADMIN_TOKEN, '?topicId=77');
      expect(byTopic.map((event) => event.subjectId)).toEqual([`${chatF}:1`]);
      const byTopic2 = await listEvents(ADMIN_TOKEN, '?topicId=88');
      expect(byTopic2.map((event) => event.subjectId)).toEqual([`${chatF}:ban:2`]);
      // moduleId matches metadata.moduleId AND before/after snapshots —
      // both command events carry moduleId in their after snapshot.
      const byModule = await listEvents(ADMIN_TOKEN, '?moduleId=moderation');
      expect(byModule.map((event) => event.subjectId).sort()).toEqual([`${chatF}:ban:1`, `${chatF}:ban:2`]);
    });

    it('filters by occurredFrom / occurredTo window', async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();
      expect((await listEvents(ADMIN_TOKEN, `?occurredFrom=${encodeURIComponent(past)}`)).length).toBeGreaterThanOrEqual(5);
      expect(await listEvents(ADMIN_TOKEN, `?occurredFrom=${encodeURIComponent(future)}`)).toEqual([]);
      expect((await listEvents(ADMIN_TOKEN, `?occurredFrom=${encodeURIComponent(past)}&occurredTo=${encodeURIComponent(future)}&category=member`)).length).toBeGreaterThanOrEqual(3);
    });

    it('cursor pagination: stable total order, no duplicates, no losses, terminating', async () => {
      // 25 site-visible + extra rows are already present from beforeEach
      // seeds; ask for tiny pages to force real cursor walking.
      const collected: ApiEvent[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const path = `/api/v1/audit/events?limit=2${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const response = await api(path, ADMIN_TOKEN);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: readonly ApiEvent[]; nextCursor?: string };
        collected.push(...body.items);
        pages += 1;
        if (body.nextCursor === undefined) break;
        cursor = body.nextCursor;
        expect(pages).toBeLessThan(50); // guard against an infinite cursor loop
      }
      expect(collected.length).toBeGreaterThanOrEqual(5);
      expect(new Set(collected.map((event) => event.id)).size).toBe(collected.length); // no duplicates
      const occurredAt = (event: ApiEvent & { occurredAt: string }): string => event.occurredAt;
      for (let i = 1; i < collected.length; i += 1) {
        const previous = occurredAt(collected[i - 1]! as never);
        const current = occurredAt(collected[i]! as never);
        expect(previous >= current).toBe(true); // descending order across pages
      }
    });

    it('invalid filter values are rejected with 400 before touching the database layer', async () => {
      expect((await api('/api/v1/audit/events?occurredFrom=not-a-date', ADMIN_TOKEN)).status).toBe(400);
      expect((await api('/api/v1/audit/events?limit=0', ADMIN_TOKEN)).status).toBe(400);
      expect((await api('/api/v1/audit/events?limit=999999', ADMIN_TOKEN)).status).toBe(400);
      expect((await api('/api/v1/audit/events?category=nonexistent', ADMIN_TOKEN)).status).toBe(400);
      expect((await api('/api/v1/audit/events?status=maybe', ADMIN_TOKEN)).status).toBe(400);
      expect((await api('/api/v1/audit/events?cursor=garbage!', ADMIN_TOKEN)).status).toBe(400);
      expect((await api('/api/v1/audit/events/00000000-0000-0000-0000-000000000000', ADMIN_TOKEN)).status).toBe(404);
      expect((await api('/api/v1/audit/nonexistent', ADMIN_TOKEN)).status).toBe(404);
    });
  });
});
