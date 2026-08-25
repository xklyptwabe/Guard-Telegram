import { Buffer } from 'node:buffer';

import type { ConsumeMessage } from 'amqplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AppConfig } from '../../src/config.js';
import type { Logger } from '../../src/lib/logger.js';
import type { AuditService } from '../../src/lib/auditService.js';
import type { ActionHandler } from '../../src/lib/rabbitmq.js';
import { FakeDrizzleTableDb } from './testUtils/fakeDrizzleTable.js';
import { buildDrizzleOrmMock, FakePendingOperationsDb, fakeLogger } from './testUtils/fakePendingOperationsDb.js';

vi.mock('drizzle-orm', async (importOriginal) => buildDrizzleOrmMock(await importOriginal<typeof import('drizzle-orm')>()));

const amqpMock = vi.hoisted(() => {
  let consumer: ((message: unknown) => void) | undefined;
  const channel = {
    assertExchange: vi.fn(async () => undefined),
    assertQueue: vi.fn(async () => undefined),
    bindQueue: vi.fn(async () => undefined),
    prefetch: vi.fn(async () => undefined),
    publish: vi.fn(() => true),
    sendToQueue: vi.fn(() => true),
    waitForConfirms: vi.fn(async () => undefined),
    once: vi.fn(),
    consume: vi.fn(async (_queue: string, callback: (message: unknown) => void) => {
      consumer = callback;
      return { consumerTag: 'consumer-1' };
    }),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const connection = {
    createConfirmChannel: vi.fn(async () => channel),
    close: vi.fn(async () => undefined),
  };
  return {
    channel,
    connection,
    connect: vi.fn(async () => connection),
    deliver(message: unknown): void {
      consumer?.(message);
    },
    reset(): void {
      consumer = undefined;
      for (const fn of Object.values(channel)) {
        if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
      }
      connection.createConfirmChannel.mockClear();
      connection.close.mockClear();
      this.connect.mockClear();
    },
  };
});

vi.mock('amqplib', () => ({ default: { connect: amqpMock.connect } }));

const { consumedEnvelopes } = await import('../../src/db/schema/core.js');
const { pendingOperations } = await import('../../src/db/schema/moderation.js');
const { makeIntegrationAuditFinalizer } = await import('../../src/lib/integrations/externalOperationGateway.js');
const { PendingOperationResolvers, PendingOperationsOutbox } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
const { RabbitEnvelopeInbox } = await import('../../src/lib/rabbitmqConsumerInbox.js');
const { createRabbitMq } = await import('../../src/lib/rabbitmq.js');

function makeConsumedEnvelopesColumnKey(table: object): Map<unknown, string> {
  const columns = table as Record<string, unknown>;
  return new Map<unknown, string>([
    [columns.envelopeId, 'envelopeId'],
    [columns.status, 'status'],
    [columns.attemptCount, 'attemptCount'],
    [columns.workerId, 'workerId'],
    [columns.leaseExpiresAt, 'leaseExpiresAt'],
    [columns.lastError, 'lastError'],
    [columns.consumedAt, 'consumedAt'],
    [columns.createdAt, 'createdAt'],
    [columns.updatedAt, 'updatedAt'],
  ]);
}

class FakeConsumedEnvelopesDb extends FakeDrizzleTableDb {
  public constructor() {
    super(makeConsumedEnvelopesColumnKey(consumedEnvelopes), ['envelopeId'], {
      status: 'received',
      attemptCount: 0,
      workerId: null,
      leaseExpiresAt: null,
      lastError: null,
      consumedAt: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }
}

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

function config(): Pick<
  AppConfig,
  'rabbitMqEnabled' | 'rabbitMqUrl' | 'rabbitMqNamespace' | 'rabbitMqProductId' | 'rabbitMqPrefetch' | 'rabbitMqRetryDelayMs' | 'rabbitMqMaxRetries'
> {
  return {
    rabbitMqEnabled: true,
    rabbitMqUrl: 'amqps://rabbitmq.test',
    rabbitMqNamespace: 'test',
    rabbitMqProductId: 'bot',
    rabbitMqPrefetch: 2,
    rabbitMqRetryDelayMs: 1000,
    rabbitMqMaxRetries: 2,
  };
}

function audit(): AuditService {
  return {
    recordEntityChange: vi.fn(async (_input, mutate) => {
      await mutate({} as never);
      return { eventId: 'event-1', duplicate: false };
    }),
  } as unknown as AuditService;
}

function message(id: string, attempt = 0): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ id, type: 'platform.ping', attempt, payload: { reason: 'health' } })),
    fields: { deliveryTag: 1, redelivered: attempt > 0, exchange: '', routingKey: '' },
    properties: {},
  } as ConsumeMessage;
}

async function createBridge(db: FakeConsumedEnvelopesDb) {
  const bridge = await createRabbitMq(config(), logger(), audit(), undefined, undefined, db as never);
  bridge.registerActionSchema('platform.ping', z.object({ reason: z.string().max(128) }).strict());
  return bridge;
}

describe('RabbitEnvelopeInbox', () => {
  let db: FakeConsumedEnvelopesDb;

  beforeEach(() => {
    db = new FakeConsumedEnvelopesDb();
  });

  it('claims first delivery and only completed rows deduplicate redelivery', async () => {
    const inbox = new RabbitEnvelopeInbox(db as never, logger());
    const first = await inbox.begin('env-1');
    expect(first.claim).toBe('claimed');
    expect(first.attemptCount).toBe(1);

    await inbox.complete('env-1');
    expect(db.rows[0]?.status).toBe('completed');

    const duplicate = await inbox.begin('env-1');
    expect(duplicate.claim).toBe('completed');
  });

  it('a handler failure leaves the envelope retryable, not permanently skipped', async () => {
    const inbox = new RabbitEnvelopeInbox(db as never, logger());
    const first = await inbox.begin('env-2');
    expect(first.claim).toBe('claimed');

    await inbox.fail('env-2', new Error('handler failed'));
    expect(db.rows[0]?.status).toBe('failed');
    expect(db.rows[0]?.workerId).toBeNull();

    const redelivery = await inbox.begin('env-2');
    expect(redelivery.claim).toBe('claimed');
    expect(redelivery.attemptCount).toBe(2);
  });

  it('a concurrent duplicate cannot claim while the first worker lease is live', async () => {
    const firstWorker = new RabbitEnvelopeInbox(db as never, logger());
    const secondWorker = new RabbitEnvelopeInbox(db as never, logger());

    await firstWorker.begin('env-3');
    const duplicate = await secondWorker.begin('env-3');

    expect(duplicate.claim).toBe('busy');
    expect(db.rows[0]?.attemptCount).toBe(1);
  });

  it('an expired processing lease can be reclaimed after a worker crash', async () => {
    const firstWorker = new RabbitEnvelopeInbox(db as never, logger());
    const secondWorker = new RabbitEnvelopeInbox(db as never, logger());

    await firstWorker.begin('env-4');
    db.rows[0]!.leaseExpiresAt = new Date(Date.now() - 1);

    const reclaimed = await secondWorker.begin('env-4');
    expect(reclaimed.claim).toBe('claimed');
    expect(reclaimed.attemptCount).toBe(2);
  });

  it('complete is a worker-owned CAS and does not clobber a stolen lease', async () => {
    const firstWorker = new RabbitEnvelopeInbox(db as never, logger());
    const secondWorker = new RabbitEnvelopeInbox(db as never, logger());

    await firstWorker.begin('env-5');
    db.rows[0]!.leaseExpiresAt = new Date(Date.now() - 1);
    await secondWorker.begin('env-5');

    const completed = await firstWorker.complete('env-5');
    expect(completed).toBe(false);
    expect(db.rows[0]?.status).toBe('processing');
  });

  it('redacts secret-shaped handler errors before storing them', async () => {
    const inbox = new RabbitEnvelopeInbox(db as never, logger());
    await inbox.begin('env-6');

    await inbox.fail('env-6', new Error('publish failed: Bearer unit-secret-token'));

    const stored = JSON.stringify(db.rows[0]?.lastError);
    expect(stored).not.toContain('unit-secret-token');
    expect(stored).toContain('[redacted]');
  });
});

describe('createRabbitMq consumer dedup path', () => {
  beforeEach(() => {
    amqpMock.reset();
  });

  it('acks but does not invoke the handler again for a completed duplicate envelope', async () => {
    const db = new FakeConsumedEnvelopesDb();
    const bridge = await createBridge(db);
    const handler = vi.fn(async () => undefined);
    await bridge.consume('platform.ping', handler);

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000001'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(db.rows[0]?.status).toBe('completed'));

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000001'));

    await vi.waitFor(() => expect(amqpMock.channel.ack).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('nacks a concurrent duplicate while the first delivery is still processing', async () => {
    const db = new FakeConsumedEnvelopesDb();
    const bridge = await createBridge(db);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => blocked);
    await bridge.consume('platform.ping', handler);

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000002'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    amqpMock.deliver(message('00000000-0000-4000-8000-000000000002'));

    await vi.waitFor(() => expect(amqpMock.channel.nack).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledTimes(1);

    release?.();
    await vi.waitFor(() => expect(db.rows[0]?.status).toBe('completed'));
  });

  it('a failed delivery is retryable and the retry becomes the completed dedup marker', async () => {
    const db = new FakeConsumedEnvelopesDb();
    const bridge = await createBridge(db);
    const handler = vi.fn(async (_action: Parameters<ActionHandler>[0]) => undefined);
    handler.mockRejectedValueOnce(new Error('temporary consumer error')).mockResolvedValueOnce(undefined);
    await bridge.consume('platform.ping', handler);

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000003'));
    await vi.waitFor(() => expect(db.rows[0]?.status).toBe('failed'));
    await vi.waitFor(() => expect(amqpMock.channel.ack).toHaveBeenCalledTimes(1));

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000003', 1));
    await vi.waitFor(() => expect(db.rows[0]?.status).toBe('completed'));

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000003', 1));
    await vi.waitFor(() => expect(amqpMock.channel.ack).toHaveBeenCalledTimes(3));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('keeps durable audit debt when a confirmed retry reroute cannot be audited immediately', async () => {
    const envelopeDb = new FakeConsumedEnvelopesDb();
    const operationDb = new FakePendingOperationsDb(pendingOperations);
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(operationDb as never, logger(), resolvers);
    const auditService = audit();
    vi.mocked(auditService.recordEntityChange).mockRejectedValueOnce(new Error('audit database unavailable'));
    outbox.setDefaultFinalizer(makeIntegrationAuditFinalizer(auditService, logger()));
    const bridge = await createRabbitMq(config(), logger(), auditService, outbox, resolvers, envelopeDb as never);
    bridge.registerActionSchema('platform.ping', z.object({ reason: z.string().max(128) }).strict());
    await bridge.consume('platform.ping', async () => {
      throw new Error('temporary consumer error');
    });
    let auditDebtExistedBeforeAck = false;
    amqpMock.channel.ack.mockImplementationOnce(() => {
      auditDebtExistedBeforeAck = operationDb.rows.some((row) => row.status === 'succeeded' && row.auditStatus === 'pending');
    });

    amqpMock.deliver(message('00000000-0000-4000-8000-000000000004'));

    await vi.waitFor(() => expect(amqpMock.channel.sendToQueue).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(amqpMock.channel.ack).toHaveBeenCalledTimes(1));
    expect(operationDb.rows).toHaveLength(1);
    expect(operationDb.rows[0]).toMatchObject({
      kind: 'rabbitmq.reroute.audit',
      status: 'succeeded',
      auditStatus: 'pending',
    });
    expect(auditDebtExistedBeforeAck).toBe(true);

    await outbox.recoverPending();

    expect(operationDb.rows[0]?.auditStatus).toBe('written');
    expect(amqpMock.channel.sendToQueue).toHaveBeenCalledTimes(1);
  });
});
