import { and, eq } from 'drizzle-orm';

import type { TelegramBotModule } from './contracts.js';
import type { DrizzleDatabase } from '../db/client.js';
import { chatModuleStates, telegramChats } from '../db/schema/core.js';
import { getUpdateContext } from '../lib/context.js';
import type { AuditService } from '../lib/auditService.js';
import type { EventBus } from '../lib/eventBus.js';
import type { Logger } from '../lib/logger.js';
import { AuditEventProcessor } from '../lib/audit/eventProcessor.js';
import { observed } from '../lib/audit/snapshot.js';
import { toDownstreamMutationResult } from '../lib/audit/serviceAdapter.js';

export interface ModuleState {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SetModuleEnabledOptions {
  readonly actorId?: string;
  readonly idempotencyKey?: string;
}

export function resolveModuleEnabled(defaultEnabled: boolean, override: boolean | undefined): boolean {
  return override ?? defaultEnabled;
}

export class MissingModuleAuditIdempotencyKeyError extends Error {
  public constructor() {
    super('ModuleRegistry.setEnabled requires an update context or explicit audit idempotency key.');
    this.name = 'MissingModuleAuditIdempotencyKeyError';
  }
}

function moduleStateAuditIdempotencyKey(chatId: string, moduleId: string): string {
  const context = getUpdateContext();
  if (!context) throw new MissingModuleAuditIdempotencyKeyError();
  return `module.state.changed:telegram-update:${context.updateId}:${chatId}:${moduleId}`;
}

export class ModuleRegistry {
  private readonly modulesById: ReadonlyMap<string, TelegramBotModule>;
  // BOTS-7's registry: runs schema validation, allowlist, and forbidden-key
  // masking on before/after before anything reaches BOTS-6's AuditService.
  // Previously setEnabled() built before/after by hand and this pipeline
  // was never invoked at all.
  private readonly auditProcessor = new AuditEventProcessor();

  public constructor(
    modules: readonly TelegramBotModule[],
    private readonly db: DrizzleDatabase,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly logger: Logger,
  ) {
    this.modulesById = new Map(modules.map((module) => [module.id, module]));
  }

  public get modules(): readonly TelegramBotModule[] {
    return [...this.modulesById.values()];
  }

  public get(moduleId: string): TelegramBotModule | undefined {
    return this.modulesById.get(moduleId);
  }

  public async ensureChat(chatId: string, type: string, title?: string): Promise<void> {
    const now = new Date();
    await this.db
      .insert(telegramChats)
      .values({ chatId, type, ...(title ? { title } : {}), updatedAt: now })
      .onConflictDoUpdate({
        target: telegramChats.chatId,
        set: { type, ...(title ? { title } : {}), updatedAt: now },
      });
  }

  public async isEnabled(chatId: string, moduleId: string): Promise<boolean> {
    const module = this.requireModule(moduleId);
    const row = await this.db
      .select({ enabled: chatModuleStates.enabled })
      .from(chatModuleStates)
      .where(and(eq(chatModuleStates.chatId, chatId), eq(chatModuleStates.moduleId, moduleId)))
      .limit(1);
    return resolveModuleEnabled(module.defaultEnabled, row[0]?.enabled);
  }

  public async listStates(chatId: string): Promise<readonly ModuleState[]> {
    return Promise.all(this.modules.map(async (module) => ({ id: module.id, enabled: await this.isEnabled(chatId, module.id) })));
  }

  public async setEnabled(
    chatId: string,
    moduleId: string,
    enabled: boolean,
    actorIdOrOptions?: string | SetModuleEnabledOptions,
  ): Promise<void> {
    const module = this.requireModule(moduleId);
    const options = typeof actorIdOrOptions === 'string' ? { actorId: actorIdOrOptions } : actorIdOrOptions;
    const actorId = options?.actorId;
    const idempotencyKey = options?.idempotencyKey ?? moduleStateAuditIdempotencyKey(chatId, moduleId);
    const afterSource = enabled === module.defaultEnabled ? 'default' : 'override';
    const result = await this.audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType: 'chat_module_state',
        subjectId: `${chatId}:${moduleId}`,
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'telegram.command',
        idempotencyKey,
        ...(actorId !== undefined ? { actorId, actorType: 'telegram_user' } : { actorType: 'telegram_user' }),
        // No `metadata` here: severity/siteVisible/canBeDisabled are now
        // static per-event-type columns on audit.event_types (seeded from
        // the registry via scripts/seedAuditEventTypes.ts), not
        // per-occurrence data — no need to repeat them on every row.
        // `operation` (which Maxim does want in metadata.operation, for
        // filtering/analytics) isn't knowable yet at this point for an
        // entity-like event like this one — it's only computed once the
        // row is read below, inside `mutate`, after this input object has
        // already shipped. Per Maxim: not critical right now, revisit once
        // `AuditMutationResult` supports returning metadata too.
      },
      async (tx) => {
        const current = await tx
          .select({ enabled: chatModuleStates.enabled })
          .from(chatModuleStates)
          .where(and(eq(chatModuleStates.chatId, chatId), eq(chatModuleStates.moduleId, moduleId)))
          .limit(1)
          .for('update');
        const beforeEnabled = resolveModuleEnabled(module.defaultEnabled, current[0]?.enabled);
        // Sparse override tracking (BOTS-7 spec: "хранить эффективное
        // значение и источник default/override") — a row present means an
        // explicit override; its absence means the module is inheriting
        // its default. Previously not tracked anywhere at all.
        const beforeSource = current[0] ? 'override' : 'default';
        const now = new Date();
        if (enabled === module.defaultEnabled) {
          await tx.delete(chatModuleStates).where(and(eq(chatModuleStates.chatId, chatId), eq(chatModuleStates.moduleId, moduleId)));
        } else {
          await tx
            .insert(chatModuleStates)
            .values({ chatId, moduleId, enabled, updatedAt: now })
            .onConflictDoUpdate({
              target: [chatModuleStates.chatId, chatModuleStates.moduleId],
              set: { enabled, updatedAt: now },
            });
        }

        // Route through BOTS-7's registry: validates against the
        // module.state.changed schema, applies the allowlist, and strips
        // forbidden keys, before anything reaches the audit event row.
        // Previously this callback built before/after by hand and none of
        // that pipeline ever ran.
        // A genuine noop requires both the effective value *and* its
        // source to be unchanged. Value-only comparison misses a real
        // case: if an admin redundantly overrides a module to its own
        // default (creating an unnecessary row) and later sets it to the
        // same value again, the override row above gets deleted as
        // cleanup — the boolean doesn't change, but the row does, and
        // source flips override → default. That's a real state change,
        // not a noop, even though `enabled` alone looks unchanged.
        const operation = beforeEnabled === enabled && beforeSource === afterSource ? 'noop' : 'update';
        const record = this.auditProcessor.process({
          name: 'module.state.changed',
          version: 1,
          operation,
          chatId,
          ...(actorId !== undefined ? { actorId } : {}),
          before: observed({ chatId, moduleId, enabled: beforeEnabled, source: beforeSource }),
          after: observed({ chatId, moduleId, enabled, source: afterSource }),
        });
        const mutationResult = toDownstreamMutationResult(record);

        return {
          ...mutationResult,
          // snapshotData carries `defaultEnabled` too, beyond what this
          // one event's `after` needs — BOTS-6's own concept for the
          // queryable "current state" row, not something the generic
          // registry knows about, so it's merged in here rather than in
          // the adapter.
          snapshotData: { ...mutationResult.snapshotData, defaultEnabled: module.defaultEnabled },
        };
      },
    );
    // A duplicate means `mutate` above never ran at all — the row was
    // never touched, `beforeEnabled`/`afterSource`/etc were never even
    // computed. Firing onEnable/onDisable, the event bus publish, or the
    // log line here would replay side effects for a state change that, as
    // far as the DB is concerned, never happened on this call. This is
    // exactly the case BOTS-9's "idempotent replayed Update" requirement
    // is about — previously this return value was silently discarded and
    // every one of these ran unconditionally, defeating the point of
    // idempotencyKey for anything downstream of the audit write itself.
    if (result.duplicate) {
      this.logger.debug({ event: 'module.state.changed.duplicate_skipped', module: moduleId, chatId });
      return;
    }
    if (enabled) await module.onEnable?.(chatId);
    else await module.onDisable?.(chatId);
    this.logger.info({ event: enabled ? 'module.enabled' : 'module.disabled', module: moduleId, chatId });
    this.events.publish('module.state.changed', { chatId, moduleId, enabled });
  }

  private requireModule(moduleId: string): TelegramBotModule {
    const module = this.modulesById.get(moduleId);
    if (!module) throw new Error(`Unknown module ID: ${moduleId}`);
    return module;
  }
}
