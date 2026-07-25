# S3/MinIO storage

Storage is off by default. It is intended only for a module that explicitly needs an export, report, or user-approved file; it must never archive chats or media automatically. Enabled S3 requires credentials and bucket, and custom endpoint/public URL validation accepts HTTPS only.

The bootstrap constructs an `ObjectStorage` no-op when disabled. A module must choose an explicit fallback or a localized refusal; it may not silently copy content into a different store. Presigned-link policy remains module-specific and must use short expiry.
