DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_retention') THEN
    GRANT USAGE ON SCHEMA audit TO audit_retention;
    GRANT SELECT ON audit.event_types TO audit_retention;
    GRANT SELECT ON audit.event_policies TO audit_retention;
    GRANT SELECT, DELETE ON audit.events TO audit_retention;
    GRANT SELECT, DELETE ON audit.outbox TO audit_retention;
    REVOKE INSERT, UPDATE ON audit.events FROM audit_retention;
    REVOKE INSERT, UPDATE ON audit.outbox FROM audit_retention;
    REVOKE INSERT, UPDATE, DELETE ON audit.event_types FROM audit_retention;
    REVOKE INSERT, UPDATE, DELETE ON audit.event_policies FROM audit_retention;
    REVOKE INSERT, UPDATE, DELETE ON audit.entity_snapshots FROM audit_retention;
  END IF;
END $$;
