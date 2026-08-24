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

/**
 * BOT-13 fix: `normalizeSnapshotData`/`normalizeSnapshotSide` validate
 * against `sparseSnapshotSchema ?? snapshotSchema` and then run the result
 * through `applyAllowlist` — a plain `z.object()` silently drops any key
 * it doesn't know about, and `applyAllowlist` only keeps what's in
 * `allowlist`. Without this, `memberAudit.ts`'s `observedAt` (the whole
 * basis for its out-of-order/staleness check) was written into
 * `snapshotData` in memory but never actually reached the database —
 * every subsequent read saw `observedAt: undefined`, silently disabling
 * the protection. Caught by `tests/integration/bot13.e2e.test.ts` against
 * a real Postgres; no fake/mock ever exercises real schema stripping.
 */
export const memberStatusSnapshotSchema = memberStatusChangedSchema.extend({
  observedAt: z.string().optional(),
  /** Round-2 (HIGH): strictly-increasing update_id — tie-breaker for equal-second updates. */
  observedUpdateId: z.number().int().optional(),
});

export const botMembershipChangedSchema = z.object({
  chatId: z.string().min(1),
  status: z.enum(['member', 'administrator', 'left', 'kicked']),
});

/**
 * BOT-9 review finding (HIGH-2): the bot's `status` staying
 * `'administrator'` says nothing about *which* admin rights it holds — a
 * chat owner silently revoking `can_restrict_members` (leaving the bot
 * unable to moderate) or `can_delete_messages` is a safety-critical change
 * this schema previously had no field for at all, so it was recorded as a
 * `noop` with empty `changes`. Field names mirror Telegram's own
 * `ChatMemberAdministrator` — see grammY's `manage.d.ts` — restricted to
 * the rights meaningful for a bot account (`custom_title` and the
 * channel-only `can_post_messages`/`can_edit_messages` are not).
 */
export const botAdministratorRightsSchema = z.object({
  canManageChat: z.boolean(),
  canDeleteMessages: z.boolean(),
  canManageVideoChats: z.boolean(),
  canRestrictMembers: z.boolean(),
  canPromoteMembers: z.boolean(),
  canChangeInfo: z.boolean(),
  canInviteUsers: z.boolean(),
  canPinMessages: z.boolean().optional(),
  canManageTopics: z.boolean().optional(),
  // BOTS-9 review round-2 (HIGH-4): full ChatMemberAdministrator rights
  // coverage — the previously missing fields. `is_anonymous` is common on
  // group admins; the stories/messages/direct-messages/tags fields are
  // group- or channel-relevant depending on the account. All optional so
  // older snapshots and providers that omit a field keep validating; each
  // is only recorded when Telegram actually sent it.
  isAnonymous: z.boolean().optional(),
  canPostStories: z.boolean().optional(),
  canEditStories: z.boolean().optional(),
  canDeleteStories: z.boolean().optional(),
  canPostMessages: z.boolean().optional(),
  canEditMessages: z.boolean().optional(),
  canManageDirectMessages: z.boolean().optional(),
  canManageTags: z.boolean().optional(),
});

export const botMembershipSnapshotSchemaBase = botMembershipChangedSchema.extend({
  rights: botAdministratorRightsSchema.optional(),
});

/** See {@link memberStatusSnapshotSchema} — same schema-stripping fix, for bot.membership.changed's observedAt. */
export const botMembershipSnapshotSchema = botMembershipSnapshotSchemaBase.extend({
  observedAt: z.string().optional(),
  /** Round-2 (HIGH): strictly-increasing update_id — tie-breaker for equal-second updates. */
  observedUpdateId: z.number().int().optional(),
});

export const moderationActionSchema = z.object({
  chatId: z.string().min(1),
  targetUserId: z.string().min(1),
  actorUserId: z.string().min(1),
  action: z.enum(['ban', 'kick', 'mute', 'warn', 'unban', 'unmute']),
  reason: z.string().max(500).optional(),
  durationSeconds: z.number().int().positive().optional(),
  /**
   * BOTS-9 review finding (HIGH-8): `kick` is two Telegram calls (ban,
   * then unban) inside one compound operation — if the ban half succeeds
   * and the unban half then confirms-fails, the target is left banned,
   * not kicked, and that must not be indistinguishable from "kick simply
   * failed, target unaffected". Only ever set for a `kick` whose ban
   * step succeeded but whose unban step didn't.
   */
  partialOutcome: z.literal('banned_not_kicked').optional(),
});

export const messageEditedSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  // Channel posts and anonymous-admin messages legitimately have no `from`.
  // The message state remains observable even when Telegram does not expose
  // an actor, so omit the author rather than fabricating one.
  userId: z.string().min(1).optional(),
  editedAt: z.string(),
  /** Round-2 (HIGH): Telegram's strictly-increasing update_id, the tie-breaker when two edits share the same second-precision `editedAt`. */
  observedUpdateId: z.number().int().optional(),
  textLength: z.number().int().nonnegative(),
  text: z.string().max(4096).optional(),
});

export const messageDeletedSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  // The Bot API sends no payload at all for a deletion, so the original
  // author is only known if this message was previously observed (an earlier
  // message or edit, or the delete was triggered by replying to the message,
  // which still carries its author).
  // When neither is true, `before` is `not_observed` and this is omitted —
  // never fabricated. See the module doc in `src/lib/audit/messageAudit.ts`.
  userId: z.string().min(1).optional(),
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
  /** Round-2 (HIGH-2): first-class outcome — failed and unknown are distinguishable, not collapsed into `success: false`. */
  outcome: z.enum(['succeeded', 'failed', 'unknown']),
  /** Derived from `outcome`; kept for backward-compatible readers. */
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
export type MemberStatusChangedSnapshot = z.infer<typeof memberStatusSnapshotSchema>;
export type BotMembershipChangedSnapshot = z.infer<typeof botMembershipSnapshotSchema>;
export type BotAdministratorRights = z.infer<typeof botAdministratorRightsSchema>;
export type ModerationActionSnapshot = z.infer<typeof moderationActionSchema>;
export type MessageEditedSnapshot = z.infer<typeof messageEditedSchema>;
export type MessageDeletedSnapshot = z.infer<typeof messageDeletedSchema>;
export type CommandExecutedSnapshot = z.infer<typeof commandExecutedSchema>;
export type IntegrationActionSnapshot = z.infer<typeof integrationActionSchema>;
export type AuditExportedSnapshot = z.infer<typeof auditExportedSchema>;
export type AuditRetentionCompletedSnapshot = z.infer<typeof auditRetentionCompletedSchema>;
