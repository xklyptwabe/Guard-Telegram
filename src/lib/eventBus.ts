import type { Logger } from './logger.js';

export interface BotEvents {
  readonly 'module.state.changed': { readonly chatId: string; readonly moduleId: string; readonly enabled: boolean };
}

type Listener<T> = (payload: T) => Promise<void> | void;

export class EventBus {
  private readonly listeners = new Map<keyof BotEvents, Set<Listener<never>>>();

  public constructor(private readonly logger: Logger) {}

  public on<Name extends keyof BotEvents>(name: Name, listener: Listener<BotEvents[Name]>): void {
    const current = this.listeners.get(name) ?? new Set<Listener<never>>();
    current.add(listener);
    this.listeners.set(name, current);
  }

  public publish<Name extends keyof BotEvents>(name: Name, payload: BotEvents[Name]): void {
    for (const listener of this.listeners.get(name) ?? []) {
      void Promise.resolve(listener(payload as never)).catch((error: unknown) => {
        this.logger.error({ event: 'event_bus.listener.failed', details: { eventName: name }, error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
      });
    }
  }
}
