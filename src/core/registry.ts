import { and, eq } from 'drizzle-orm';

import type { TelegramBotModule } from './contracts.js';
import type { DrizzleDatabase } from '../db/client.js';
import { chatModuleStates, telegramChats } from '../db/schema/core.js';
import type { AuditService } from '../lib/auditService.js';
import type { EventBus } from '../lib/eventBus.js';
import type { Logger } from '../lib/logger.js';

export interface ModuleState {
  readonly id: string;
  readonly enabled: boolean;
}

export function resolveModuleEnabled(defaultEnabled: boolean, override: boolean | undefined): boolean {
  return override ?? defaultEnabled;
}

export class ModuleRegistry {
  private readonly modulesById: ReadonlyMap<string, TelegramBotModule>;

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

  public async setEnabled(chatId: string, moduleId: string, enabled: boolean): Promise<void> {
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
        actorType: 'telegram_user',
      },
      async (tx) => {
        const current = await tx
          .select({ enabled: chatModuleStates.enabled })
          .from(chatModuleStates)
          .where(and(eq(chatModuleStates.chatId, chatId), eq(chatModuleStates.moduleId, moduleId)))
          .limit(1)
          .for('update');
        const beforeEnabled = resolveModuleEnabled(module.defaultEnabled, current[0]?.enabled);
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
        return {
          before: { enabled: beforeEnabled },
          after: { enabled },
          ...(beforeEnabled === enabled ? {} : { changes: { enabled: { before: beforeEnabled, after: enabled } } }),
          snapshotData: { chatId, moduleId, enabled, defaultEnabled: module.defaultEnabled },
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
