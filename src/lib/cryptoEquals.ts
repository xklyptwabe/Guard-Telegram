import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets without leaking length or first-mismatch position.
 * SHA-256 both sides, then timingSafeEqual on fixed-size digests.
 */
export function constantTimeEquals(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
