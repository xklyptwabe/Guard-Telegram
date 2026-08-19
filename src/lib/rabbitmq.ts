import { randomUUID } from 'node:crypto';

import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import { recordIntegrationAction } from './audit/integrationAudit.js';
import type { AuditService } from './auditService.js';
import type { Logger } from './logger.js';
import type { PendingOperationResolvers, PendingOperationsOutbox } from './moderation/pendingOperationsOutbox.js';
import { integrationOperationMetadata } from './integrations/externalOperationGateway.js';

const actionEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
  attempt: z.number().int().min(0),
  payload: z.unknown(),
});

type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;
export type ActionHandler = (action: ActionEnvelope) => Promise<void>;

export interface RabbitMqBridge {
  readonly enabled: boolean;
  publish(type: string, payload: unknown): Promise<void>;
  consume(type: string, handler: ActionHandler): Promise<void>;
  /**
   * BOTS-9 review round-2 (BLOCKER-3): registers the Zod schema that
   * defines the *only* fields allowed in `payload` for an action type.
   * Publishing an action type with no registered schema is rejected, and
   * publishing with a payload that fails the schema is rejected too —
   * a raw Telegram Update (or any other unvalidated blob) can therefore
   * never reach `moderation.pending_operations.request_payload`. The
   * parsed (normalized) payload is what gets persisted AND published, so
   * live execution and post-restart recovery use the identical envelope.
   */
  registerActionSchema(type: string, schema: z.ZodType): void;
  close(): Promise<void>;
}

interface RabbitTopology {
  readonly actionsExchange: string;
  readonly actionQueue: string;
  readonly retryQueue: string;
  readonly deadLetterQueue: string;
  readonly routingKey: string;
}

function buildTopology(config: Pick<AppConfig, 'rabbitMqNamespace' | 'rabbitMqProductId'>): RabbitTopology {
  const base = `${config.rabbitMqNamespace}.${config.rabbitMqProductId}`;
  return {
    actionsExchange: `${config.rabbitMqNamespace}.actions`,
    actionQueue: `${base}.actions`,
    retryQueue: `${base}.retry`,
    deadLetterQueue: `${base}.dlq`,
    routingKey: `action.${config.rabbitMqProductId}`,
  };
}

async function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, envelope: ActionEnvelope): Promise<void> {
  const accepted = channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(envelope)), {
    contentType: 'application/json',
    deliveryMode: 2,
    messageId: envelope.id,
  });
  if (!accepted) await new Promise<void>((resolve) => channel.once('drain', resolve));
  await channel.waitForConfirms();
}

export async function createRabbitMq(
  config: Pick<AppConfig, 'rabbitMqEnabled' | 'rabbitMqUrl' | 'rabbitMqNamespace' | 'rabbitMqProductId' | 'rabbitMqPrefetch' | 'rabbitMqRetryDelayMs' | 'rabbitMqMaxRetries'>,
  logger: Logger,
  audit: AuditService,
  outbox?: PendingOperationsOutbox,
  resolvers?: PendingOperationResolvers,
): Promise<RabbitMqBridge> {
  if (!config.rabbitMqEnabled) {
    return {
      enabled: false,
      publish: () => Promise.resolve(),
      consume: () => Promise.resolve(),
      registerActionSchema: () => undefined,
      close: () => Promise.resolve(),
    };
  }
  if (!config.rabbitMqUrl) throw new Error('RabbitMQ URL is required when RabbitMQ is enabled');
  const connection: ChannelModel = await amqp.connect(config.rabbitMqUrl);
  const channel = await connection.createConfirmChannel();
  const topology = buildTopology(config);
  await channel.assertExchange(topology.actionsExchange, 'topic', { durable: true });
  await channel.assertQueue(topology.actionQueue, { durable: true });
  await channel.bindQueue(topology.actionQueue, topology.actionsExchange, topology.routingKey);
  await channel.assertQueue(topology.retryQueue, {
    durable: true,
    arguments: {
      'x-message-ttl': config.rabbitMqRetryDelayMs,
      'x-dead-letter-exchange': topology.actionsExchange,
      'x-dead-letter-routing-key': topology.routingKey,
    },
  });
  await channel.assertQueue(topology.deadLetterQueue, { durable: true });
  await channel.prefetch(config.rabbitMqPrefetch);
  logger.info({ event: 'rabbitmq.connected' });

  // BOTS-9 review round-2 (BLOCKER-3): strict per-action payload schemas.
  // Publishing an action type with no registered schema (or a payload that
  // fails its schema) is REJECTED before anything is persisted or sent —
  // there is no generic `unknown` escape hatch anymore.
  const actionSchemas = new Map<string, z.ZodType>();
  const validatePayload = (type: string, payload: unknown): unknown => {
    const schema = actionSchemas.get(type);
    if (!schema) {
      throw new Error(`No payload schema registered for rabbit action type "${type}" — refusing to publish/persist an unvalidated payload (BLOCKER-3)`);
    }
    return schema.parse(payload); // normalized: unknown keys stripped, types coerced
  };

  const rawPublish = async (type: string, payload: unknown): Promise<void> => {
    const normalizedPayload = validatePayload(type, payload);
    const envelope = actionEnvelopeSchema.parse({ id: randomUUID(), type, attempt: 0, payload: normalizedPayload });
    await publishConfirmed(channel, topology.actionsExchange, topology.routingKey, envelope);
  };

  const publishViaOutbox = async (type: string, payload: unknown): Promise<void> => {
    // BOTS-9 review fix (BLOCKER-3): durable intent BEFORE the external
    // call. The envelope — including its id — is created here from the
    // NORMALIZED payload (schema-validated, only allowed fields) and stored
    // in the write-ahead row, so every retry (this process or a
    // post-restart recovery) republishes the SAME envelope id with the SAME
    // normalized payload and consumers can dedupe redeliveries. Live and
    // recovery execution therefore use one identical model — no raw
    // update can reach the DB, and no divergence between the two paths.
    const normalizedPayload = validatePayload(type, payload);
    const envelope = actionEnvelopeSchema.parse({ id: randomUUID(), type, attempt: 0, payload: normalizedPayload });
    const kind = 'rabbitmq.publish';
    const result = await outbox!.execute(
      {
        kind,
        chatId: 'platform',
        idempotencyKey: `rabbitmq.publish:${envelope.id}`,
        requestPayload: { envelope },
        metadata: integrationOperationMetadata({ integrationId: 'rabbitmq', action: type, targetType: 'queue', targetId: topology.actionQueue }),
      },
      async () => {
        await publishConfirmed(channel, topology.actionsExchange, topology.routingKey, envelope);
        return { messageId: envelope.id };
      },
    );
    if (result.outcome.status === 'failed') {
      throw new Error(`RabbitMQ publish failed: ${JSON.stringify(result.outcome.result ?? {})}`);
    }
  };

  // Best-effort post-call audit (DLQ/retry rerouting, outbox-less bootstrap
  // path): must never break the call's own result — the audit failure is
  // logged and swallowed here by design (see integrationAudit.ts's note).
  const auditBestEffort = async (input: Omit<Parameters<typeof recordIntegrationAction>[2], 'outcome'> & { outcome: 'succeeded' | 'failed' | 'unknown' }): Promise<void> => {
    try {
      await recordIntegrationAction(audit, logger, input);
    } catch (error: unknown) {
      logger.warn({
        event: 'audit.integration_action.best_effort_failed',
        details: { integrationId: input.integrationId, action: input.action, targetType: input.targetType, targetId: input.targetId },
        error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const publish = outbox
    ? publishViaOutbox
    : // Outbox unavailable (early bootstrap/tests) — the pre-BLOCKER-3
      // direct path, still post-call audited (best-effort).
      async (type: string, payload: unknown): Promise<void> => {
        try {
          await rawPublish(type, payload);
        } catch (error: unknown) {
          await auditBestEffort({ integrationId: 'rabbitmq', action: type, targetType: 'queue', targetId: topology.actionQueue, outcome: 'unknown' });
          throw error;
        }
        await auditBestEffort({ integrationId: 'rabbitmq', action: type, targetType: 'queue', targetId: topology.actionQueue, outcome: 'succeeded' });
      };

  // Recovery executor for `rabbitmq.publish` rows found after a restart:
  // republish the STORED envelope — same id, so broker/consumer dedup holds.
  resolvers?.register('rabbitmq.publish', async (stored) => {
    const envelope = actionEnvelopeSchema.parse((stored as { envelope: unknown }).envelope);
    await publishConfirmed(channel, topology.actionsExchange, topology.routingKey, envelope);
    return { messageId: envelope.id };
  });

  const sendToQueue = async (queue: string, envelope: ActionEnvelope): Promise<void> => {
    const accepted = channel.sendToQueue(queue, Buffer.from(JSON.stringify(envelope)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: envelope.id,
    });
    if (!accepted) await new Promise<void>((resolve) => channel.once('drain', resolve));
    await channel.waitForConfirms();
  };

  /**
   * DLQ/retry rerouting gets a post-call `integration.action` record but
   * deliberately NOT a write-ahead row (BOTS-9 review HIGH-5, documented
   * exclusion): the source message stays unacked until the reroute is
   * confirmed, and on any reroute failure it is nacked back to the ORIGINAL
   * queue — RabbitMQ's own redelivery is the durable retry mechanism here,
   * and interleaving a DB roundtrip into that ack/nack window would change
   * consumer ordering semantics for no reliability gain. `channel.ack` /
   * `channel.nack` themselves are protocol-level and stay unaudited for the
   * same reason.
   */
  const rerouteWithAudit = async (queue: string, envelope: ActionEnvelope, action: string): Promise<void> => {
    try {
      await sendToQueue(queue, envelope);
      await auditBestEffort({ integrationId: 'rabbitmq', action, targetType: 'queue', targetId: queue, outcome: 'succeeded' });
    } catch (error: unknown) {
      await auditBestEffort({ integrationId: 'rabbitmq', action, targetType: 'queue', targetId: queue, outcome: 'unknown' });
      throw error;
    }
  };

  const handlers = new Map<string, ActionHandler>();
  const handleMessage = async (message: ConsumeMessage): Promise<void> => {
    let action: ActionEnvelope;
    try {
      action = actionEnvelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
      // BOTS-9 review round-2 (BLOCKER-3): inbound payloads for a known
      // action type are normalized through the SAME registered schema —
      // an envelope whose payload violates it is treated as invalid.
      const payloadSchema = actionSchemas.get(action.type);
      if (payloadSchema) {
        const parsedPayload = payloadSchema.safeParse(action.payload);
        if (!parsedPayload.success) throw new Error(`Invalid payload for registered action type "${action.type}"`);
        action = { ...action, payload: parsedPayload.data };
      }
    } catch (error: unknown) {
    try {
      await sendToQueue(topology.deadLetterQueue, { id: randomUUID(), type: 'invalid', attempt: 0, payload: { reason: 'invalid_message' } });
      await auditBestEffort({ integrationId: 'rabbitmq', action: 'dlq', targetType: 'queue', targetId: topology.deadLetterQueue, outcome: 'succeeded' });
      channel.ack(message);
      logger.warn({ event: 'rabbitmq.invalid_to_dlq', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
    } catch {
      channel.nack(message, false, true);
    }
    return;
  }
    try {
      const handler = handlers.get(action.type);
      if (!handler) throw new Error('No consumer registered for action type');
      await handler(action);
      channel.ack(message);
    } catch (error: unknown) {
      const next = { ...action, attempt: action.attempt + 1 };
      logger.warn({ event: 'rabbitmq.handler_failed', details: { actionType: action.type, attempt: next.attempt }, error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
      try {
        if (next.attempt > config.rabbitMqMaxRetries) {
          await rerouteWithAudit(topology.deadLetterQueue, next, 'dlq');
          logger.warn({ event: 'rabbitmq.exhausted_to_dlq', details: { actionType: action.type, attempt: next.attempt } });
        } else {
          await rerouteWithAudit(topology.retryQueue, next, 'retry');
          logger.warn({ event: 'rabbitmq.retry_scheduled', details: { actionType: action.type, attempt: next.attempt } });
        }
        channel.ack(message);
      } catch (publishError: unknown) {
        logger.error({ event: 'rabbitmq.retry_publish_failed', details: { actionType: action.type }, error: { name: publishError instanceof Error ? publishError.name : 'UnknownError', message: publishError instanceof Error ? publishError.message : String(publishError) } });
        channel.nack(message, false, true);
      }
    }
  };

  let consumerStarted = false;
  return {
    enabled: true,
    publish,
    registerActionSchema(type: string, schema: z.ZodType): void {
      actionSchemas.set(type, schema);
    },
    async consume(type: string, handler: ActionHandler): Promise<void> {
      handlers.set(type, handler);
      if (consumerStarted) return;
      await channel.consume(topology.actionQueue, (message) => {
        if (message) void handleMessage(message);
      });
      consumerStarted = true;
    },
    async close(): Promise<void> {
      await channel.close();
      await connection.close();
      logger.info({ event: 'rabbitmq.closed' });
    },
  };
}
