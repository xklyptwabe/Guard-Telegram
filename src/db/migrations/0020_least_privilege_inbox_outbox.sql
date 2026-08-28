-- 0019 granted table-level UPDATE on inbox/outbox, undoing 0014/0017 column
-- grants. Restore least privilege: identity and payload stay immutable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'moderation' AND table_name = 'pending_operations'
    ) THEN
      REVOKE UPDATE ON moderation.pending_operations FROM telegram_bot;
      GRANT UPDATE (
        status,
        attempt_count,
        last_attempt_at,
        next_attempt_at,
        worker_id,
        lease_expires_at,
        result,
        audit_status,
        audit_worker_id,
        audit_lease_expires_at,
        updated_at
      ) ON moderation.pending_operations TO telegram_bot;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'core' AND table_name = 'processed_updates'
    ) THEN
      REVOKE UPDATE ON core.processed_updates FROM telegram_bot;
      GRANT UPDATE (
        status,
        attempt_count,
        worker_id,
        lease_expires_at,
        next_attempt_at,
        last_error,
        processed_at,
        updated_at
      ) ON core.processed_updates TO telegram_bot;
    END IF;
  END IF;
END $$;
