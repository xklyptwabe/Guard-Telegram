import { and, eq } from 'drizzle-orm';

import type { TelegramBotModule } from './contracts.js';
import type { DrizzleDatabase } from '../db/client.js';
import { chatModuleStates, telegramChats } from '../db/schema/core.js';
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

export function resolveModuleEnabled(defaultEnabled: boolean, override: boolean | undefined): boolean {
  return override ?? defaultEnabled;
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

  public async setEnabled(chatId: string, moduleId: string, enabled: boolean, actorId?: string): Promise<void> {
    const module = this.requireModule(moduleId);
    await this.audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType: 'chat_module_state',
        subjectId: `${chatId}:${moduleId}`,
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'telegram.command',
        idempotencyKey: `module.state.changed:${chatId}:${moduleId}:${enabled}`,
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
        const afterSource = enabled === module.defaultEnabled ? 'default' : 'override';
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
        const record = this.auditProcessor.process({
          name: 'module.state.changed',
          version: 1,
          operation: beforeEnabled === enabled ? 'noop' : 'update',
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
