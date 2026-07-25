import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface UpdateContext {
  readonly correlationId: string;
  readonly updateId: string;
  readonly chatId?: string;
  readonly userId?: string;
}

const updateContext = new AsyncLocalStorage<UpdateContext>();

export function getUpdateContext(): UpdateContext | undefined {
  return updateContext.getStore();
}

export function runWithUpdateContext<T>(metadata: Omit<UpdateContext, 'correlationId'>, operation: () => Promise<T>): Promise<T> {
  return updateContext.run({ correlationId: randomUUID(), ...metadata }, operation);
}
