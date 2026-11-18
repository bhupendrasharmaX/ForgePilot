import * as crypto from 'crypto';

/**
 * Computes SHA-256 hash of a string or buffer.
 * Used for verifying file consistency and preventing stale diff application.
 */
export function computeSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
