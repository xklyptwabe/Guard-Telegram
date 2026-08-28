import type { AppConfig } from '../config.js';
import type { RedisClient } from '../db/redis.js';
import type { AuditOperationalState } from './audit/operationalState.js';
import type { Logger } from './logger.js';
import type { RabbitMqBridge } from './rabbitmq.js';
import type { ObjectStorage } from './storage.js';

const STALE_EXTERNAL_OPERATION_SECONDS = 5 * 60;

export interface AuditHealthSource {
  readOperationalState(now?: Date): Promise<AuditOperationalState>;
  hasRecentWriteFailure(now?: number): boolean;
}

export interface HealthSnapshot {
  readonly status: 'ok' | 'degraded' | 'unhealthy';
  readonly transport: AppConfig['telegramTransport'];
  readonly database: 'ready' | 'unhealthy';
  readonly redis: 'disabled' | 'ready' | 'degraded';
  readonly storage: 'disabled' | 'ready';
  readonly rabbitMq: 'disabled' | 'ready' | 'unhealthy';
  readonly audit: {
    readonly status: 'ready' | 'degraded' | 'unhealthy';
    readonly recentWriteFailure: boolean;
    readonly delivery: {
      readonly pending: number | null;
      readonly failed: number | null;
      readonly oldestPendingAgeSeconds: number | null;
    };
    readonly externalOperations: {
      readonly pending: number | null;
      readonly inProgress: number | null;
      readonly retryScheduled: number | null;
      readonly auditPending: number | null;
      readonly terminalUnknown: number | null;
      readonly oldestUnfinishedAgeSeconds: number | null;
    };
  };
}

export async function healthSnapshot(
  config: Pick<AppConfig, 'telegramTransport' | 'redisEnabled' | 's3Enabled' | 'rabbitMqEnabled'>,
  redis: RedisClient,
  storage: ObjectStorage,
  rabbitMq: RabbitMqBridge,
  auditSource: AuditHealthSource,
  logger?: Logger,
  now = new Date(),
): Promise<HealthSnapshot> {
  const redisState: HealthSnapshot['redis'] = !config.redisEnabled
    ? 'disabled'
    : redis.isAvailable()
      ? 'ready'
      : 'degraded';
  const rabbitMqState: HealthSnapshot['rabbitMq'] = !config.rabbitMqEnabled
    ? 'disabled'
    : rabbitMq.enabled
      ? 'ready'
      : 'unhealthy';
  const recentWriteFailure = auditSource.hasRecentWriteFailure(now.getTime());

  try {
    const state = await auditSource.readOperationalState(now);
    const auditState: HealthSnapshot['audit']['status'] =
      recentWriteFailure ||
      state.delivery.failed > 0 ||
      state.externalOperations.auditPending > 0 ||
      (state.externalOperations.oldestUnfinishedAgeSeconds ?? 0) >= STALE_EXTERNAL_OPERATION_SECONDS
        ? 'degraded'
        : 'ready';

    return {
      status: overallStatus(rabbitMqState, redisState, auditState),
      transport: config.telegramTransport,
      database: 'ready',
      redis: redisState,
      storage: storage.enabled ? 'ready' : 'disabled',
      rabbitMq: rabbitMqState,
      audit: { status: auditState, recentWriteFailure, ...state },
    };
  } catch (error: unknown) {
    logger?.error({
      event: 'health.audit_state_failed',
      error: {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      status: 'unhealthy',
      transport: config.telegramTransport,
      database: 'unhealthy',
      redis: redisState,
      storage: storage.enabled ? 'ready' : 'disabled',
      rabbitMq: rabbitMqState,
      audit: {
        status: 'unhealthy',
        recentWriteFailure,
        delivery: { pending: null, failed: null, oldestPendingAgeSeconds: null },
        externalOperations: {
          pending: null,
          inProgress: null,
          retryScheduled: null,
          auditPending: null,
          terminalUnknown: null,
          oldestUnfinishedAgeSeconds: null,
        },
      },
    };
  }
}

function overallStatus(
  rabbitMq: HealthSnapshot['rabbitMq'],
  redis: HealthSnapshot['redis'],
  audit: HealthSnapshot['audit']['status'],
): HealthSnapshot['status'] {
  if (rabbitMq === 'unhealthy' || audit === 'unhealthy') return 'unhealthy';
  if (redis === 'degraded' || audit === 'degraded') return 'degraded';
  return 'ok';
}
