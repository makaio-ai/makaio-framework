/**
 * Shared wiring response schemas for per-client `wiring.*` tool calls.
 *
 * These schemas are consumed by individual client packages (e.g.
 * `@makaio/claude-code-client`) and by the global `wiring.*` aggregator.
 * @packageDocumentation
 */

import * as path from 'node:path';
import { z } from 'zod';
import { ClientWiringEntrySchema, type ClientWiringEntry } from '@makaio/contracts/client';

export { ClientWiringEntrySchema, type ClientWiringEntry };

/**
 * Non-empty absolute filesystem path.
 *
 * Used for `projectDir` across all config and wiring subjects to ensure paths
 * are not resolved relative to the service process cwd.
 */
export const AbsolutePathSchema = z.string().min(1).refine(path.isAbsolute, {
  message: 'projectDir must be an absolute path',
});

/**
 * Shared response schema for per-client `wiring.list`.
 *
 * Returns all known wiring entries for the requested scope, indicating which
 * are currently installed.
 */
export const ClientWiringListResponseSchema = z.object({
  /** All wiring entries for the requested scope. */
  entries: z.array(ClientWiringEntrySchema),
});

/** Inferred type for {@link ClientWiringListResponseSchema}. */
export type ClientWiringListResponse = z.infer<typeof ClientWiringListResponseSchema>;

/**
 * Shared response schema for per-client `wiring.apply`.
 *
 * Reports how many entries were written and how many were already in place.
 */
export const ClientWiringApplyResponseSchema = z.object({
  /** Number of entries written during this apply operation. */
  applied: z.number().int().nonnegative(),
  /** Number of entries that were already installed and required no change. */
  skipped: z.number().int().nonnegative(),
});

/** Inferred type for {@link ClientWiringApplyResponseSchema}. */
export type ClientWiringApplyResponse = z.infer<typeof ClientWiringApplyResponseSchema>;

/**
 * Shared response schema for per-client `wiring.remove`.
 *
 * Reports how many entries were removed from the config file.
 */
export const ClientWiringRemoveResponseSchema = z.object({
  /** Number of entries removed during this remove operation. */
  removed: z.number().int().nonnegative(),
});

/** Inferred type for {@link ClientWiringRemoveResponseSchema}. */
export type ClientWiringRemoveResponse = z.infer<typeof ClientWiringRemoveResponseSchema>;

/**
 * A single client's wiring result in the global aggregation response.
 *
 * Returned by `client.wiring.list` for each enabled client that responded
 * to the per-client `wiring.list` bus request.
 */
export const ClientWiringAggregatedResultSchema = z.object({
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  clientId: z.string().trim().min(1),
  /** All wiring entries reported by this client. */
  entries: z.array(ClientWiringEntrySchema),
});

/** Inferred type for {@link ClientWiringAggregatedResultSchema}. */
export type ClientWiringAggregatedResult = z.infer<typeof ClientWiringAggregatedResultSchema>;

/**
 * Assert that `projectDir`, when provided, is an absolute path.
 *
 * Prevents relative paths from being resolved against the service process cwd
 * and causing writes to unintended filesystem locations. Used by per-client
 * wiring handlers as a runtime guard when bus-layer Zod validation may be
 * skipped in production.
 * @param projectDir - Path value from the request payload, or `undefined`.
 * @throws Error When `projectDir` is defined but not an absolute path.
 */
export function assertAbsoluteProjectDir(projectDir: string | undefined): void {
  if (projectDir !== undefined && !path.isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path, got: ${projectDir}`);
  }
}
