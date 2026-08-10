import { randomUUID } from 'node:crypto';

import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import { recordIntegrationAction } from './audit/integrationAudit.js';
import type { AuditService } from './auditService.js';
import type { Logger } from './logger.js';

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

export async function createRabbitMq(config: Pick<AppConfig, 'rabbitMqEnabled' | 'rabbitMqUrl' | 'rabbitMqNamespace' | 'rabbitMqProductId' | 'rabbitMqPrefetch' | 'rabbitMqRetryDelayMs' | 'rabbitMqMaxRetries'>, logger: Logger, audit: AuditService): Promise<RabbitMqBridge> {
  if (!config.rabbitMqEnabled) {
    return {
      enabled: false,
      publish: () => Promise.resolve(),
      consume: () => Promise.resolve(),
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

  const rawPublish = async (type: string, payload: unknown): Promise<void> => {
    const envelope = actionEnvelopeSchema.parse({ id: randomUUID(), type, attempt: 0, payload });
    await publishConfirmed(channel, topology.actionsExchange, topology.routingKey, envelope);
  };

  const publish = async (type: string, payload: unknown): Promise<void> => {
    try {
      await rawPublish(type, payload);
    } catch (error: unknown) {
      // Audit recording never throws on its own (see integrationAudit.ts) —
      // it cannot mask or replace the real failure being rethrown below.
      await recordIntegrationAction(audit, logger, {
        integrationId: 'rabbitmq',
        action: type,
        targetType: 'queue',
        targetId: topology.actionQueue,
        success: false,
      });
      throw error;
    }
    await recordIntegrationAction(audit, logger, {
      integrationId: 'rabbitmq',
      action: type,
      targetType: 'queue',
      targetId: topology.actionQueue,
      success: true,
    });
  };

  const sendToQueue = async (queue: string, envelope: ActionEnvelope): Promise<void> => {
    const accepted = channel.sendToQueue(queue, Buffer.from(JSON.stringify(envelope)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: envelope.id,
    });
    if (!accepted) await new Promise<void>((resolve) => channel.once('drain', resolve));
    await channel.waitForConfirms();
  };

  const handlers = new Map<string, ActionHandler>();
  const handleMessage = async (message: ConsumeMessage): Promise<void> => {
    let action: ActionEnvelope;
    try {
      action = actionEnvelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
    } catch (error: unknown) {
      try {
        await sendToQueue(topology.deadLetterQueue, { id: randomUUID(), type: 'invalid', attempt: 0, payload: { reason: 'invalid_message' } });
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
          await sendToQueue(topology.deadLetterQueue, next);
          logger.warn({ event: 'rabbitmq.exhausted_to_dlq', details: { actionType: action.type, attempt: next.attempt } });
        } else {
          await sendToQueue(topology.retryQueue, next);
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
