CREATE INDEX IF NOT EXISTS "events_retention_candidates_idx"
ON "audit"."events" ("occurred_at" ASC, "id" ASC)
WHERE "metadata" #>> '{auditPolicy,values,retentionDays}' ~ '^[0-9]+$';
