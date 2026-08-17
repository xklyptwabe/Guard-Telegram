import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface UpdateContext {
  readonly correlationId: string;
  readonly updateId: string;
  /** The bot's own Telegram user id — Telegram scopes `update_id` per-bot, so any idempotency key built from `updateId` alone could theoretically collide across two different bot instances/tokens sharing a database. Optional only because a handful of call sites (recovery, scripts) run outside any live Update and have no bot context to give. */
  readonly botId?: string;
  readonly chatId?: string;
  readonly userId?: string;
  readonly messageThreadId?: string;
}

const updateContext = new AsyncLocalStorage<UpdateContext>();

export function getUpdateContext(): UpdateContext | undefined {
  return updateContext.getStore();
}

export function runWithUpdateContext<T>(metadata: Omit<UpdateContext, 'correlationId'>, operation: () => Promise<T>): Promise<T> {
  return updateContext.run({ correlationId: randomUUID(), ...metadata }, operation);
}
