import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import { buildDrizzleOrmMock, FakePendingOperationsDb, fakeLogger } from './testUtils/fakePendingOperationsDb.js';

const s3Mock = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('drizzle-orm', async (importOriginal) => buildDrizzleOrmMock(await importOriginal<typeof import('drizzle-orm')>()));

vi.mock('@aws-sdk/client-s3', () => {
  class S3ServiceException extends Error {
    public readonly $metadata: { readonly httpStatusCode?: number };
    public constructor(message: string, status?: number) {
      super(message);
      this.name = 'S3ServiceException';
      this.$metadata = status === undefined ? {} : { httpStatusCode: status };
    }
  }
  return {
    S3Client: class {
      public send = s3Mock.send;
      public destroy = vi.fn();
    },
    PutObjectCommand: class {},
    HeadObjectCommand: class {},
    S3ServiceException,
  };
});

const { pendingOperations } = await import('../../src/db/schema/moderation.js');
const { PendingOperationResolvers, PendingOperationsOutbox } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
const { createStorage } = await import('../../src/lib/storage.js');
const { HeadObjectCommand, S3ServiceException } = await import('@aws-sdk/client-s3');

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

describe('createStorage().put (round-5)', () => {
  let db: FakePendingOperationsDb;

  beforeEach(() => {
    db = new FakePendingOperationsDb(pendingOperations);
    s3Mock.send.mockReset();
    s3Mock.send.mockRejectedValue(new Error('socket hang up'));
  });

  it('throws on transport unknown — the caller must not treat the put as succeeded', async () => {
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 5, 20);
    const storage = createStorage(
      {
        s3Enabled: true,
        s3Region: 'us-east-1',
        s3AccessKeyId: 'ak',
        s3SecretAccessKey: 'sk',
        s3Bucket: 'bucket',
      },
      logger(),
      outbox,
      resolvers,
    );

    await expect(storage.put('obj/a.bin', new Uint8Array([1, 2, 3]), 'application/octet-stream')).rejects.toThrow(/S3 put unknown/);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.status).toBe('unknown');
    expect(String(db.rows[0]?.idempotencyKey)).toMatch(/^s3\.putObject:[0-9a-f-]{36}$/);
  });

  it('keeps a timed-out put unknown after HEAD 404 reconciliation through createStorage', async () => {
    const notFound = Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
    Object.setPrototypeOf(notFound, S3ServiceException.prototype);
    s3Mock.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw notFound;
      throw new Error('socket hang up');
    });

    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 2, 20);
    const storage = createStorage(
      {
        s3Enabled: true,
        s3Region: 'us-east-1',
        s3AccessKeyId: 'ak',
        s3SecretAccessKey: 'sk',
        s3Bucket: 'bucket',
      },
      logger(),
      outbox,
      resolvers,
    );

    await expect(storage.put('obj/reconcile.bin', new Uint8Array([1]), 'application/octet-stream')).rejects.toThrow(/S3 put unknown/);
    expect(db.rows[0]?.status).toBe('unknown');
    db.rows[0]!.nextAttemptAt = new Date(0);

    await outbox.recoverPending();

    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.attemptCount).toBe(2);
    expect(db.rows[0]?.nextAttemptAt).toBeNull();
    expect(s3Mock.send.mock.calls.some(([command]) => command instanceof HeadObjectCommand)).toBe(true);
  });

  it('does not collapse two intentional puts with the same key and body', async () => {
    s3Mock.send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    outbox.setDefaultFinalizer(async () => ({ status: 'recorded' }));
    const storage = createStorage(
      {
        s3Enabled: true,
        s3Region: 'us-east-1',
        s3AccessKeyId: 'ak',
        s3SecretAccessKey: 'sk',
        s3Bucket: 'bucket',
      },
      logger(),
      outbox,
      resolvers,
    );
    const body = new Uint8Array([1, 2, 3]);

    await storage.put('obj/repeated.bin', body, 'application/octet-stream');
    await storage.put('obj/repeated.bin', body, 'application/octet-stream');

    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]?.idempotencyKey).not.toBe(db.rows[1]?.idempotencyKey);
    expect(s3Mock.send).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a caller-redelivered put when the same operation key is supplied', async () => {
    s3Mock.send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    outbox.setDefaultFinalizer(async () => ({ status: 'recorded' }));
    const storage = createStorage(
      {
        s3Enabled: true,
        s3Region: 'us-east-1',
        s3AccessKeyId: 'ak',
        s3SecretAccessKey: 'sk',
        s3Bucket: 'bucket',
      },
      logger(),
      outbox,
      resolvers,
    );
    const options = { idempotencyKey: 'business-operation-42' };

    await storage.put('obj/repeated.bin', new Uint8Array([1]), 'application/octet-stream', options);
    await storage.put('obj/repeated.bin', new Uint8Array([1]), 'application/octet-stream', options);

    expect(db.rows).toHaveLength(1);
    expect(s3Mock.send).toHaveBeenCalledTimes(1);
  });
});
