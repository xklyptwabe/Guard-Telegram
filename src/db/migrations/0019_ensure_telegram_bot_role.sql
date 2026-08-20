-- Application role must exist before REVOKE/GRANT in 0001/0011/0014–0017
-- can take effect. Previously those blocks were no-ops when the role was
-- missing, so a superuser connection kept UPDATE/DELETE on audit.events.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    CREATE ROLE telegram_bot
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO telegram_bot', current_database());
  GRANT USAGE ON SCHEMA audit TO telegram_bot;
  GRANT USAGE ON SCHEMA core TO telegram_bot;
  GRANT USAGE ON SCHEMA moderation TO telegram_bot;
  GRANT USAGE ON SEQUENCE audit.subject_sequence TO telegram_bot;

  GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO telegram_bot;
  REVOKE UPDATE, DELETE ON audit.events FROM telegram_bot;

  GRANT UPDATE (
    snapshot_status,
    snapshot_data,
    last_subject_sequence,
    last_event_id,
    updated_at
  ) ON audit.entity_snapshots TO telegram_bot;

  GRANT UPDATE (
    enabled,
    site_visible,
    snapshot_mode,
    allowlist,
    masking,
    retention_days,
    severity,
    export_allowed,
    lock_version,
    updated_at
  ) ON audit.event_policies TO telegram_bot;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'pending_operations'
  ) THEN
    GRANT SELECT, INSERT ON moderation.pending_operations TO telegram_bot;
    GRANT UPDATE ON moderation.pending_operations TO telegram_bot;
    REVOKE DELETE ON moderation.pending_operations FROM telegram_bot;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'core' AND table_name = 'processed_updates'
  ) THEN
    GRANT SELECT, INSERT, UPDATE ON core.processed_updates TO telegram_bot;
  END IF;
END $$;
