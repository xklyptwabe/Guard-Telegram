export class UnregisteredAuditEventError extends Error {
  public constructor(public readonly eventName: string) {
    super(`Audit event "${eventName}" is not registered. Refusing to process an unknown event.`);
    this.name = 'UnregisteredAuditEventError';
  }
}

export class UnsupportedAuditEventVersionError extends Error {
  public constructor(
    public readonly eventName: string,
    public readonly receivedVersion: number,
    public readonly supportedVersions: readonly number[],
  ) {
    super(
      `Audit event "${eventName}" version ${receivedVersion} is not supported ` +
        `(supported: ${supportedVersions.join(', ')}).`,
    );
    this.name = 'UnsupportedAuditEventVersionError';
  }
}

export class AuditSnapshotValidationError extends Error {
  public constructor(
    public readonly eventName: string,
    public readonly side: 'before' | 'after' | 'snapshotData',
    public readonly issues: string,
  ) {
    super(`Audit event "${eventName}" ${side} snapshot failed schema validation: ${issues}`);
    this.name = 'AuditSnapshotValidationError';
  }
}
