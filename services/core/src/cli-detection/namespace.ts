/**
 * CLI Detection Bus Namespace
 *
 * Bus subjects for CLI tool detection and version checking.
 * @packageDocumentation
 */
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';

/** Detection result for a single CLI binary. */
export const CLIDetectionResultSchema = z.object({
  /** Binary name (e.g., "claude", "codex") */
  binary: z.string(),
  /** Whether the binary was found in PATH */
  found: z.boolean(),
  /** Detected version string (if found) */
  version: z.string().optional(),
  /** Full path to the binary (if found) */
  path: z.string().optional(),
});

export type CLIDetectionResult = z.infer<typeof CLIDetectionResultSchema>;

/** CLI Detection service schemas. */
const CLIDetectionSchemas = {
  /**
   * Scan for CLI tools.
   *
   * Detects installed CLI binaries and their versions.
   */
  scan: {
    request: z.object({
      binaries: z.array(z.string()),
    }),
    response: z.object({
      results: z.array(CLIDetectionResultSchema),
    }),
  },
} as const;

/** CLI Detection namespace registration. */
export const CLIDetectionNamespace = createBusNamespace('cliDetection', CLIDetectionSchemas);

/** Typed subjects for CLI detection operations. */
export const CLIDetectionSubjects = CLIDetectionNamespace.subjects;
