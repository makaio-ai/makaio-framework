/**
 * Binary resolution schemas for the `client.resolveBinary` bus command.
 *
 * These schemas describe the execution context returned when resolving which
 * binary to use for a given client, including the path, environment overrides,
 * config directory, source, and version.
 * @packageDocumentation
 */

import { z } from 'zod';
import { AbsolutePathSchema, NonEmptyStringSchema } from './primitives.js';

/**
 * Execution context returned by the `client.resolveBinary` command.
 *
 * Describes everything a caller needs to spawn the resolved client binary:
 * the path (or `null` to use PATH lookup), environment overrides, the config
 * directory in effect, the resolution source, and the resolved version.
 */
export const ClientExecutionContextSchema = z.object({
  /** Absolute path to the resolved binary, or null when the caller should use PATH default. */
  binaryPath: AbsolutePathSchema.nullable(),
  /** Environment variables to set when spawning the binary. */
  env: z.record(z.string(), z.string()),
  /** Absolute path to the config directory the binary will use, or null when no config isolation is active. */
  configDir: AbsolutePathSchema.nullable(),
  /** Where the binary was resolved from. */
  source: z.enum(['managed', 'global']),
  /** Resolved version string, or null when unknown. */
  version: NonEmptyStringSchema.nullable(),
});

export type ClientExecutionContext = z.infer<typeof ClientExecutionContextSchema>;

/**
 * Request and response schemas for `client.resolveBinary`.
 *
 * Resolves the binary path, environment overrides, and config directory for a
 * given client. The response is everything a caller needs to spawn the binary.
 *
 * Phase 2 optional fields (`sessionId`, `projectDir`, `preferSource`,
 * `harnessId`) are declared now as seams so the handler contract is stable
 * before the implementations land.
 */
export const ClientResolveBinarySchema = {
  request: z.object({
    /** Stable client identifier to resolve (e.g. `'claude-code'`). */
    clientId: NonEmptyStringSchema,
    /** Session ID for session-scoped overrides (Phase 2). */
    sessionId: NonEmptyStringSchema.optional(),
    /** Project directory for project-scoped overrides (Phase 2). */
    projectDir: AbsolutePathSchema.optional(),
    /** Explicit source preference (Phase 2). */
    preferSource: z.enum(['managed', 'global']).optional(),
    /**
     * Harness ID for harness-scoped config materialization (Phase 2).
     * When provided, `resolveBinary` returns a harness-specific `configDir`.
     */
    harnessId: NonEmptyStringSchema.optional(),
  }),
  response: ClientExecutionContextSchema,
};

export type ClientResolveBinaryRequest = z.infer<typeof ClientResolveBinarySchema.request>;
export type ClientResolveBinaryResponse = z.infer<typeof ClientResolveBinarySchema.response>;
