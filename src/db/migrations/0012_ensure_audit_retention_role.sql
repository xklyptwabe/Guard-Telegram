DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_retention') THEN
    CREATE ROLE audit_retention
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO audit_retention', current_database());
  GRANT USAGE ON SCHEMA audit TO audit_retention;
  GRANT USAGE ON SEQUENCE audit.subject_sequence TO audit_retention;
  GRANT SELECT ON audit.event_types TO audit_retention;
  GRANT SELECT ON audit.event_policies TO audit_retention;
  GRANT SELECT, INSERT, DELETE ON audit.events TO audit_retention;
  GRANT SELECT, INSERT, DELETE ON audit.outbox TO audit_retention;
  GRANT SELECT, INSERT, UPDATE ON audit.entity_snapshots TO audit_retention;
  REVOKE UPDATE ON audit.events FROM audit_retention;
  REVOKE UPDATE ON audit.outbox FROM audit_retention;
  REVOKE INSERT, UPDATE, DELETE ON audit.event_types FROM audit_retention;
  REVOKE INSERT, UPDATE, DELETE ON audit.event_policies FROM audit_retention;
  REVOKE DELETE ON audit.entity_snapshots FROM audit_retention;
END $$;
