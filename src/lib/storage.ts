import { createHash, randomUUID } from 'node:crypto';

import { HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';

import type { AppConfig } from '../config.js';
import type { Logger } from './logger.js';
import { ConfirmedExternalError, type PendingOperationResolvers, type PendingOperationsOutbox } from './moderation/pendingOperationsOutbox.js';
import { integrationOperationMetadata } from './integrations/externalOperationGateway.js';

export interface ObjectStorage {
  readonly enabled: boolean;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  close(): Promise<void>;
}

export function createStorage(
  config: Pick<AppConfig, 's3Enabled' | 's3Endpoint' | 's3Region' | 's3AccessKeyId' | 's3SecretAccessKey' | 's3Bucket'>,
  logger: Logger,
  outbox?: PendingOperationsOutbox,
  resolvers?: PendingOperationResolvers,
): ObjectStorage {
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

  const kind = 's3.putObject';

  if (outbox && resolvers) {
    // Recovery executor (BOTS-9 review BLOCKER-3): a row found after a
    // restart has no body to re-upload — files must never be persisted to
    // the outbox (BLOCKER-4). Instead it RECONCILES: S3 objects are atomic,
    // so a HEAD either proves the original upload landed (→ succeeded) or
    // proves it never did (→ confirmed failed; the intent is unrecoverable
    // without the caller, which the audit trail now states explicitly). A
    // network-level HEAD failure stays `unknown` and retries — HEAD is
    // read-only, so retrying it is always safe.
    resolvers.register(kind, async (payload) => {
      const key = String(payload.key);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
        return { reconciled: true, statusCode: head.$metadata.httpStatusCode };
      } catch (error: unknown) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          throw new ConfirmedExternalError('object absent after unrecoverable upload — body is never stored in the outbox', { errorCode: 404 });
        }
        throw error;
      }
    });

    return {
      enabled: true,
      // BOTS-9 review fix (BLOCKER-3): write-ahead BEFORE the external call.
      // The intent row stores the key/contentType/digest/size — never the
      // body itself — plus the metadata the audit finalizer needs to write
      // the terminal `integration.action` record after any outcome,
      // including one resolved by recovery long after this call returned.
      put: async (key, body, contentType) => {
        const bodyDigest = createHash('sha256').update(body).digest('hex');
        const result = await outbox.execute(
          {
            kind,
            // chat-less integration: the pending_operations row lives under
            // the platform pseudo-scope, mirroring audit's tenant sentinel.
            chatId: 'platform',
            idempotencyKey: `s3.putObject:${key}:${bodyDigest}:${randomUUID()}`,
            requestPayload: { key, contentType, bodyDigest, sizeBytes: body.byteLength },
            metadata: integrationOperationMetadata({ integrationId: 's3', action: 'put', targetType: 'object', targetId: key }),
          },
          async (payload) => {
            try {
              const put = await client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: String(payload.key), Body: body, ContentType: contentType }));
              return { statusCode: put.$metadata.httpStatusCode };
            } catch (error: unknown) {
              // An S3 *response* (4xx/5xx) is a confirmed rejection, not an
              // unknown — see ConfirmedExternalError. Transport-level errors
              // (no HTTP status) stay unknown and are retried.
              if (error instanceof S3ServiceException && error.$metadata.httpStatusCode !== undefined) {
                throw new ConfirmedExternalError(error.message, { errorCode: error.$metadata.httpStatusCode, description: error.name });
              }
              throw error;
            }
          },
        );
        if (result.outcome.status === 'failed') {
          // Confirmed rejection — surface to the caller exactly as the
          // pre-outbox implementation did (it rethrew the SDK error).
          throw new Error(`S3 put failed: ${JSON.stringify(result.outcome.result ?? {})}`);
        }
      },
      close: () => {
        client.destroy();
        return Promise.resolve();
      },
    };
  }

  // Outbox unavailable (early bootstrap/tests) — keep the direct path.
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
