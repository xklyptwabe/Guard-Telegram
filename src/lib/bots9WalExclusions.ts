/**
 * BOTS-9 accepted write-ahead exclusions (review HIGH-5).
 * These mutations are not routed through pending_operations.
 * Changing the set requires an explicit review, not a silent new call site.
 */
export const BOTS9_WAL_EXCLUSIONS = [
  'telegram.sendMessage',
  'telegram.answerCallbackQuery',
  'telegram.setMyCommands',
  'telegram.setWebhook',
  'rabbitmq.ack',
  'rabbitmq.nack',
] as const;

export type Bots9WalExclusion = (typeof BOTS9_WAL_EXCLUSIONS)[number];

export function bots9WalExclusion(kind: Bots9WalExclusion): Bots9WalExclusion {
  return kind;
}
