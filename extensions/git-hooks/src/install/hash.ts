/**
 * Shared cryptographic helpers for the git-hooks install pipeline.
 * @packageDocumentation
 */

import * as crypto from 'node:crypto';

/**
 * Compute the SHA-256 hex digest of a UTF-8 string.
 * @param content - Text content to hash.
 * @returns SHA-256 hex digest of the content.
 */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
