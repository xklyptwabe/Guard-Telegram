import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import { buildDrizzleOrmMock, FakePendingOperationsDb, fakeLogger } from './testUtils/fakePendingOperationsDb.js';

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
      public send = vi.fn(async () => {
        throw new Error('socket hang up');
      });
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

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

describe('createStorage().put (round-5)', () => {
  let db: FakePendingOperationsDb;

  beforeEach(() => {
    db = new FakePendingOperationsDb(pendingOperations);
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
    expect(String(db.rows[0]?.idempotencyKey)).toMatch(/^s3\.putObject:obj\/a\.bin:[0-9a-f]{64}$/);
    expect(String(db.rows[0]?.idempotencyKey)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
