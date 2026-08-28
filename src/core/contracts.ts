import type { Context } from 'grammy';
import type { ZodType } from 'zod';

import type { ModuleRegistry } from './registry.js';
import type { EventBus } from '../lib/eventBus.js';
import type { Logger } from '../lib/logger.js';
import type { ReplyService } from '../lib/reply.js';

export type ModulePermission = 'none' | 'chat_admin';

export interface CommandExecutionContext {
  readonly ctx: Context;
  readonly chatId: string;
  readonly userId: string;
  readonly moduleId: string;
  readonly registry: ModuleRegistry;
  readonly logger: Logger;
  readonly reply: ReplyService;
  readonly events: EventBus;
  t(key: string, options?: Record<string, string | number>): string;
}

export interface TelegramCommandDefinition {
  readonly id: string;
  readonly name: string;
  readonly moduleId: string;
  readonly descriptionKey: string;
  readonly permission: ModulePermission;
  readonly cooldownMs: number;
  readonly argsSchema: ZodType<unknown>;
  execute(context: CommandExecutionContext, args: unknown): Promise<void>;
}

export interface TelegramUpdateHandler {
  readonly id: string;
  handle(ctx: Context): Promise<void>;
}

export interface TelegramBotModule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly global: boolean;
  readonly defaultEnabled: boolean;
  /**
   * Modules whose removal would break the chat's own administration
   * surface. Disabling such a module through `/module_disable` would lock
   * the chat's admins out of module management entirely (found by the
   * BOTS-13 post-acceptance bug hunt); `ModuleRegistry.setEnabled` refuses
   * the operation for these.
   */
  readonly protectFromDisable?: boolean;
  readonly commands?: readonly TelegramCommandDefinition[];
  readonly updateHandlers?: readonly TelegramUpdateHandler[];
  onEnable?(chatId: string): Promise<void>;
  onDisable?(chatId: string): Promise<void>;
}
