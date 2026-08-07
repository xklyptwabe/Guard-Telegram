import { z } from 'zod';

import { backendApiPrincipalConfigSchema } from './api/access.js';

const optionalString = z.string().trim().optional().transform((value) => value || undefined);
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value === 'true'));
const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().optional().transform((value) => value ?? defaultValue);
const databaseUrl = z.string().url().refine(
  (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
  'DATABASE_URL must use postgres:// or postgresql://',
);
const httpsUrl = z.string().url().refine(
  (value) => new URL(value).protocol === 'https:',
  'URL must use HTTPS',
);
const optionalHttpsUrl = optionalString.pipe(httpsUrl.optional());
const backendApiPrincipals = optionalString.transform((value, context) => {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return z.array(backendApiPrincipalConfigSchema).parse(parsed);
  } catch (error: unknown) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'BACKEND_API_TOKENS must be a JSON array',
    });
    return z.NEVER;
  }
});
const telegramUpdateTypes = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'message_reaction',
  'message_reaction_count',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
] as const;

const configSchema = z
  .object({
    telegramBotToken: z.string().trim().min(1).max(512),
    databaseUrl,
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    telegramTransport: z.enum(['long_polling', 'webhook']).default('long_polling'),
    telegramAllowedUpdates: z
      .string()
      .default('message,callback_query,my_chat_member')
      .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
      .pipe(z.array(z.enum(telegramUpdateTypes)))
      .refine((items) => items.length > 0, 'TELEGRAM_ALLOWED_UPDATES must not be empty'),
    telegramRunnerConcurrency: positiveInteger(25),
    telegramTopicFallbackToChat: booleanFromEnv(false),
    telegramWebhookUrl: optionalHttpsUrl,
    telegramWebhookSecret: optionalString,
    telegramWebhookPort: positiveInteger(8080),
    databaseTlsRejectUnauthorized: booleanFromEnv(true),
    databaseTlsCa: optionalString,
    databaseTlsCert: optionalString,
    databaseTlsKey: optionalString,
    backendApiEnabled: booleanFromEnv(false),
    backendApiHost: z.string().trim().min(1).default('127.0.0.1'),
    backendApiPort: positiveInteger(8081),
    backendApiPrincipals,
    auditRetentionDatabaseUrl: optionalString.pipe(databaseUrl.optional()),
    redisEnabled: booleanFromEnv(false),
    redisHost: z.string().trim().min(1).default('127.0.0.1'),
    redisPort: positiveInteger(6379),
    redisDb: z.coerce.number().int().min(0).default(0),
    redisKeyPrefix: z.string().min(1).default('telegram-bot:dev:'),
    redisUsername: z.string().trim().min(1).default('default'),
    redisPassword: optionalString,
    redisTls: booleanFromEnv(true),
    redisTlsRejectUnauthorized: booleanFromEnv(true),
    s3Enabled: booleanFromEnv(false),
    s3Endpoint: optionalHttpsUrl,
    s3Region: z.string().trim().min(1).default('us-east-1'),
    s3AccessKeyId: optionalString,
    s3SecretAccessKey: optionalString,
    s3Bucket: optionalString,
    s3PublicUrl: optionalHttpsUrl,
    rabbitMqEnabled: booleanFromEnv(false),
    rabbitMqUrl: optionalString,
    rabbitMqNamespace: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).default('wolfram.ecosystem.dev'),
    rabbitMqProductId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default('telegram-bot'),
    rabbitMqPrefetch: positiveInteger(10),
    rabbitMqRetryDelayMs: positiveInteger(5000),
    rabbitMqMaxRetries: positiveInteger(5),
  })
  .superRefine((config, context) => {
    if (config.telegramTransport === 'webhook') {
      if (!config.telegramWebhookUrl) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['telegramWebhookUrl'], message: 'Required for webhook transport' });
      }
      if (!config.telegramWebhookSecret || config.telegramWebhookSecret.length < 16) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['telegramWebhookSecret'], message: 'A 16+ character secret is required for webhook transport' });
      }
    }
    if (Boolean(config.databaseTlsCert) !== Boolean(config.databaseTlsKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['databaseTlsCert'], message: 'DATABASE_TLS_CERT and DATABASE_TLS_KEY must be set together' });
    }
    if (config.redisEnabled && !config.redisTls) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['redisTls'], message: 'Redis requires TLS when enabled' });
    }
    if (config.s3Enabled && (!config.s3AccessKeyId || !config.s3SecretAccessKey || !config.s3Bucket)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['s3Bucket'], message: 'S3 credentials and bucket are required when S3 is enabled' });
    }
    if (config.rabbitMqEnabled) {
      if (!config.rabbitMqUrl || new URL(config.rabbitMqUrl).protocol !== 'amqps:') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['rabbitMqUrl'], message: 'RabbitMQ requires an amqps:// URL when enabled' });
      }
    }
    if (config.backendApiEnabled && config.backendApiPrincipals.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['backendApiPrincipals'], message: 'BACKEND_API_TOKENS is required when BACKEND_API_ENABLED=true' });
    }
    const tokens = new Set<string>();
    for (const principal of config.backendApiPrincipals) {
      if (tokens.has(principal.token)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['backendApiPrincipals'], message: 'BACKEND_API_TOKENS contains a duplicate token' });
        break;
      }
      tokens.add(principal.token);
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

function envToConfigInput(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    telegramTransport: env.TELEGRAM_TRANSPORT,
    telegramAllowedUpdates: env.TELEGRAM_ALLOWED_UPDATES,
    telegramRunnerConcurrency: env.TELEGRAM_RUNNER_CONCURRENCY,
    telegramTopicFallbackToChat: env.TELEGRAM_TOPIC_FALLBACK_TO_CHAT,
    telegramWebhookUrl: env.TELEGRAM_WEBHOOK_URL,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    telegramWebhookPort: env.TELEGRAM_WEBHOOK_PORT,
    databaseTlsRejectUnauthorized: env.DATABASE_TLS_REJECT_UNAUTHORIZED,
    databaseTlsCa: env.DATABASE_TLS_CA,
    databaseTlsCert: env.DATABASE_TLS_CERT,
    databaseTlsKey: env.DATABASE_TLS_KEY,
    backendApiEnabled: env.BACKEND_API_ENABLED,
    backendApiHost: env.BACKEND_API_HOST,
    backendApiPort: env.BACKEND_API_PORT,
    backendApiPrincipals: env.BACKEND_API_TOKENS,
    auditRetentionDatabaseUrl: env.AUDIT_RETENTION_DATABASE_URL,
    redisEnabled: env.REDIS_ENABLED,
    redisHost: env.REDIS_HOST,
    redisPort: env.REDIS_PORT,
    redisDb: env.REDIS_DB,
    redisKeyPrefix: env.REDIS_KEY_PREFIX,
    redisUsername: env.REDIS_USERNAME,
    redisPassword: env.REDIS_PASSWORD,
    redisTls: env.REDIS_TLS,
    redisTlsRejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
    s3Enabled: env.S3_ENABLED,
    s3Endpoint: env.S3_ENDPOINT,
    s3Region: env.S3_REGION,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3Bucket: env.S3_BUCKET,
    s3PublicUrl: env.S3_PUBLIC_URL,
    rabbitMqEnabled: env.RABBITMQ_ENABLED,
    rabbitMqUrl: env.RABBITMQ_URL,
    rabbitMqNamespace: env.RABBITMQ_NAMESPACE,
    rabbitMqProductId: env.RABBITMQ_PRODUCT_ID,
    rabbitMqPrefetch: env.RABBITMQ_PREFETCH,
    rabbitMqRetryDelayMs: env.RABBITMQ_RETRY_DELAY_MS,
    rabbitMqMaxRetries: env.RABBITMQ_MAX_RETRIES,
  };
}

export function validateConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(envToConfigInput(env));
}
