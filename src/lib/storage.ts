import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { AppConfig } from '../config.js';
import type { Logger } from './logger.js';

export interface ObjectStorage {
  readonly enabled: boolean;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  close(): Promise<void>;
}

export function createStorage(config: Pick<AppConfig, 's3Enabled' | 's3Endpoint' | 's3Region' | 's3AccessKeyId' | 's3SecretAccessKey' | 's3Bucket'>, logger: Logger): ObjectStorage {
  if (!config.s3Enabled) {
    return {
      enabled: false,
      put: () => Promise.reject(new Error('Object storage is disabled')),
      close: () => Promise.resolve(),
    };
  }
  if (!config.s3AccessKeyId || !config.s3SecretAccessKey || !config.s3Bucket) throw new Error('Incomplete S3 configuration');
  const client = new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
    credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
  });
  logger.info({ event: 'storage.connected' });
  return {
    enabled: true,
    put: async (key, body, contentType) => {
      await client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    close: () => {
      client.destroy();
      return Promise.resolve();
    },
  };
}
