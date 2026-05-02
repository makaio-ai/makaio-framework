/**
 * Shared schema primitives for the client contracts package.
 *
 * These building blocks are internal implementation details — they are NOT
 * part of the public package API. Consumers outside this package must derive
 * their constraints from the exported domain schemas, not from these
 * primitives directly.
 */

import * as path from 'node:path';
import { z } from 'zod';

/** Non-empty normalized string used for stable client identifiers. */
export const NonEmptyStringSchema = z.string().trim().min(1);

/** Epoch timestamp in milliseconds. */
export const EpochMillisecondsSchema = z
  .number()
  .int()
  .finite()
  .nonnegative()
  .describe('Unix epoch timestamp in milliseconds');

/**
 * Return `true` for POSIX, Windows drive-letter, or UNC absolute paths
 * regardless of the host OS running schema validation.
 * @param value - Candidate path from a portable framework contract.
 * @returns `true` when the value is absolute on a supported host path syntax.
 */
export function isPortableAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** Non-empty absolute filesystem path. */
export const AbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isPortableAbsolutePath, { message: 'Path must be absolute' });
