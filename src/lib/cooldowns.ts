export class Cooldowns {
  private readonly expiresAt = new Map<string, number>();

  public take(key: string, cooldownMs: number, now = Date.now()): boolean {
    const currentExpiry = this.expiresAt.get(key);
    if (currentExpiry !== undefined && currentExpiry > now) return false;
    this.expiresAt.set(key, now + cooldownMs);
    return true;
  }
}
