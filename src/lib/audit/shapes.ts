import { z } from 'zod';

/**
 * One Zod schema per event. These describe the *shape* of a snapshot only —
 * they say nothing about what is safe to persist. That is the allowlist's
 * job (see `masking.ts` and `definitions.ts`). Keeping schema and allowlist
 * separate means a field can be validated (so we know it arrived in a sane
 * shape) without ever being a candidate for storage.
 */

/**
 * Where the effective `enabled` value came from: the module's own default,
 * or an explicit per-chat override. Required by the BOTS-7 spec ("хранить
 * эффективное значение и источник default/override") so that a reader can
 * tell "this chat has never touched the setting, it's just inheriting the
 * module default" apart from "an admin explicitly overrode it" — the two
 * have very different audit meaning even when `enabled` itself is identical.
 */
export const moduleStateSourceSchema = z.enum(['default', 'override']);

export const moduleStateChangedSchema = z.object({
  chatId: z.string().min(1),
  moduleId: z.string().min(1),
  /** The effective value in force for this chat after the change. */
  enabled: z.boolean(),
  /** Whether `enabled` reflects the module default or a per-chat override. */
  source: moduleStateSourceSchema,
});

export const moduleStateChangedSparseSchema = z.object({
  chatId: z.string().min(1).optional(),
  moduleId: z.string().min(1).optional(),
  enabled: z.boolean(),
  source: moduleStateSourceSchema,
});

export const chatSettingsChangedSchema = z.object({
  chatId: z.string().min(1),
  locale: z.string().min(2).max(10),
});

export const auditPolicyChangedSchema = z.object({
  policyId: z.string().min(1),
  scope: z.string().min(1),
  targetType: z.enum(['global', 'chat', 'event_type', 'module']),
  chatId: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
  eventVersion: z.string().min(1).optional(),
  moduleId: z.string().min(1).optional(),
  enabled: z.boolean().nullable(),
  siteVisible: z.boolean().nullable(),
  snapshotMode: z.enum(['metadata', 'snapshot']).nullable(),
  allowlist: z.array(z.string().min(1)).nullable(),
  masking: z.array(z.string().min(1)).nullable(),
  retentionDays: z.number().int().nonnegative().nullable(),
  severity: z.enum(['debug', 'info', 'notice', 'warning', 'critical']).nullable(),
  exportAllowed: z.boolean().nullable(),
  lockVersion: z.number().int().positive(),
});

export const memberStatusSchema = z.enum(['member', 'administrator', 'creator', 'restricted', 'left', 'kicked']);

export const memberStatusChangedSchema = z.object({
  chatId: z.string().min(1),
  userId: z.string().min(1),
  status: memberStatusSchema,
});

export const botMembershipChangedSchema = z.object({
  chatId: z.string().min(1),
  status: z.enum(['member', 'administrator', 'left', 'kicked']),
});

export const moderationActionSchema = z.object({
  chatId: z.string().min(1),
  targetUserId: z.string().min(1),
  actorUserId: z.string().min(1),
  action: z.enum(['ban', 'kick', 'mute', 'warn', 'unban', 'unmute']),
  reason: z.string().max(500).optional(),
  durationSeconds: z.number().int().positive().optional(),
});

export const messageEditedSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  userId: z.string().min(1),
  editedAt: z.string(),
  textLength: z.number().int().nonnegative(),
  text: z.string().max(4096).optional(),
});

export const messageDeletedSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  userId: z.string().min(1),
  deletedBy: z.string().min(1).optional(),
  text: z.string().max(4096).optional(),
});

export const commandExecutedSchema = z.object({
  chatId: z.string().min(1),
  userId: z.string().min(1),
  moduleId: z.string().min(1),
  commandId: z.string().min(1),
  argsRedacted: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  success: z.boolean(),
});

export const integrationActionSchema = z.object({
  integrationId: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  statusCode: z.number().int().optional(),
  success: z.boolean(),
});

export const auditExportedSchema = z.object({
  exportId: z.string().min(1),
  requestedBy: z.string().min(1),
  format: z.enum(['csv', 'json']),
  rangeFrom: z.string(),
  rangeTo: z.string(),
  rowCount: z.number().int().nonnegative(),
});

export const auditRetentionCompletedSchema = z.object({
  jobId: z.string().min(1),
  deletedCount: z.number().int().nonnegative(),
  retentionDays: z.number().int().nonnegative(),
  batchSize: z.number().int().positive(),
  startedAt: z.string(),
  finishedAt: z.string(),
});

export type ModuleStateSource = z.infer<typeof moduleStateSourceSchema>;
export type ModuleStateChangedSnapshot = z.infer<typeof moduleStateChangedSchema>;
export type ChatSettingsChangedSnapshot = z.infer<typeof chatSettingsChangedSchema>;
export type AuditPolicyChangedSnapshot = z.infer<typeof auditPolicyChangedSchema>;
export type MemberStatusChangedSnapshot = z.infer<typeof memberStatusChangedSchema>;
export type BotMembershipChangedSnapshot = z.infer<typeof botMembershipChangedSchema>;
export type ModerationActionSnapshot = z.infer<typeof moderationActionSchema>;
export type MessageEditedSnapshot = z.infer<typeof messageEditedSchema>;
export type MessageDeletedSnapshot = z.infer<typeof messageDeletedSchema>;
export type CommandExecutedSnapshot = z.infer<typeof commandExecutedSchema>;
export type IntegrationActionSnapshot = z.infer<typeof integrationActionSchema>;
export type AuditExportedSnapshot = z.infer<typeof auditExportedSchema>;
export type AuditRetentionCompletedSnapshot = z.infer<typeof auditRetentionCompletedSchema>;
