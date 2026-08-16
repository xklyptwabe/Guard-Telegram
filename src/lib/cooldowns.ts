/**
 * Per (chat, user, command) cooldown tracking. Entries are never read again
 * once expired, but the underlying map is long-lived in the bot process, so
 * expired entries are swept once the map grows past a threshold — without
 * this, months of traffic across many chats accumulate keys indefinitely
 * (BOTS-13 bug hunt finding: unbounded memory growth).
 */
const SWEEP_THRESHOLD = 1_000;

export class Cooldowns {
  private readonly expiresAt = new Map<string, number>();

  public take(key: string, cooldownMs: number, now = Date.now()): boolean {
    if (this.expiresAt.size > SWEEP_THRESHOLD) this.sweep(now);
    const currentExpiry = this.expiresAt.get(key);
    if (currentExpiry !== undefined && currentExpiry > now) return false;
    this.expiresAt.set(key, now + cooldownMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, expiry] of this.expiresAt) {
      if (expiry <= now) this.expiresAt.delete(key);
    }
  }
}
