import { createHash } from 'node:crypto';

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
    // the outbox (BLOCKER-4). Instead it RECONCILES: a successful HEAD proves
    // the original upload landed. A 404 only proves that the object is not
    // visible at that instant; the timed-out PUT may still be in flight, and
    // custom S3-compatible endpoints need not share AWS S3's exact consistency
    // contract. HEAD failures therefore stay `unknown` and retry — HEAD is
    // read-only, so retrying it is always safe.
    resolvers.register(
      kind,
      async (payload) => {
        const key = String(payload.key);
        try {
          const head = await client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
          return { reconciled: true, statusCode: head.$metadata.httpStatusCode };
        } catch (error: unknown) {
          if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
            // Not confirmed-failed: PUT may still be in flight after our timeout.
            // HEAD is read-only — retry as unknown until attempts exhaust.
            throw new Error(`s3 HEAD 404 for ${key} — object not visible yet`);
          }
          throw error;
        }
      },
      { retryAfterUnknown: true },
    );

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
            idempotencyKey: `s3.putObject:${key}:${bodyDigest}`,
            requestPayload: { key, contentType, bodyDigest, sizeBytes: body.byteLength },
            auditEvent: { eventType: 'integration.action', eventVersion: 'v1' },
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
        if (result.isFinal && !result.auditFinalized) {
          throw new Error(`S3 put audit is still owed for key ${key}`);
        }
        if (result.outcome.status !== 'succeeded') {
          // unknown / failed / in-flight retry must NOT look like a successful put.
          throw new Error(`S3 put ${result.outcome.status}: ${JSON.stringify(result.outcome.result ?? {})}`);
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
