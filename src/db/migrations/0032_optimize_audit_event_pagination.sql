CREATE INDEX "events_tenant_occurred_id_idx"
  ON "audit"."events" USING btree ("tenant_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "events_occurred_id_idx"
  ON "audit"."events" USING btree ("occurred_at" DESC, "id" DESC);
--> statement-breakpoint
DROP INDEX "audit"."events_tenant_occurred_idx";
