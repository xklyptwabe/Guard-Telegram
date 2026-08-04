INSERT INTO "audit"."event_types" (
  "event_type",
  "event_version",
  "category",
  "severity",
  "site_visible",
  "can_be_disabled",
  "updated_at"
) VALUES
  ('module.state.changed', 'v1', 'module', 'notice', true, false, now()),
  ('chat.settings.changed', 'v1', 'chat', 'info', true, true, now()),
  ('audit.policy.changed', 'v1', 'audit', 'critical', false, false, now()),
  ('member.status.changed', 'v1', 'member', 'notice', true, true, now()),
  ('bot.membership.changed', 'v1', 'bot', 'warning', true, false, now()),
  ('moderation.action', 'v1', 'moderation', 'warning', true, false, now()),
  ('message.edited', 'v1', 'message', 'info', false, true, now()),
  ('message.deleted', 'v1', 'message', 'info', false, true, now()),
  ('command.executed', 'v1', 'command', 'info', true, true, now()),
  ('integration.action', 'v1', 'integration', 'warning', false, true, now()),
  ('audit.exported', 'v1', 'audit', 'notice', false, false, now()),
  ('audit.retention.completed', 'v1', 'audit', 'info', false, false, now())
ON CONFLICT ("event_type", "event_version") DO UPDATE SET
  "category" = EXCLUDED."category",
  "severity" = EXCLUDED."severity",
  "site_visible" = EXCLUDED."site_visible",
  "can_be_disabled" = EXCLUDED."can_be_disabled",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "audit"."event_policies" (
  "event_type",
  "event_version",
  "required",
  "enabled",
  "updated_at"
) VALUES
  ('module.state.changed', 'v1', true, true, now()),
  ('chat.settings.changed', 'v1', true, true, now()),
  ('audit.policy.changed', 'v1', true, true, now()),
  ('member.status.changed', 'v1', true, true, now()),
  ('bot.membership.changed', 'v1', true, true, now()),
  ('moderation.action', 'v1', true, true, now()),
  ('message.edited', 'v1', true, true, now()),
  ('message.deleted', 'v1', true, true, now()),
  ('command.executed', 'v1', true, true, now()),
  ('integration.action', 'v1', true, true, now()),
  ('audit.exported', 'v1', true, true, now()),
  ('audit.retention.completed', 'v1', true, true, now())
ON CONFLICT ("event_type", "event_version") DO NOTHING;
