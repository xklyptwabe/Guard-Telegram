# Audit retention role

Migration `0012_ensure_audit_retention_role.sql` creates `audit_retention` as a
limited `NOLOGIN` role and grants only the audit permissions required by the
retention job. Run migrations with a PostgreSQL owner that can create roles. If
the migration owner cannot create roles, a DBA must create `audit_retention`
before migrations run.

After migrations, enable login and set a generated password without committing
it to the repository:

    ALTER ROLE audit_retention LOGIN PASSWORD '<secret-store-password>';

Store the matching connection string in `AUDIT_RETENTION_DATABASE_URL`. Do not
reuse `DATABASE_URL`: the bot application and retention job must use different
PostgreSQL roles.
