DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
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

    REVOKE UPDATE, DELETE ON audit.events FROM telegram_bot;
  END IF;
END $$;
