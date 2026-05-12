import { z } from 'zod';

/**
 * Configuration schema for shell toolset constraints.
 * Uses Zod .describe() for UI help text generation.
 *
 * This schema exposes user-configurable settings only.
 * Internal settings (truncateMode, bufferRetentionMs, etc.) remain in ShellConstraints.
 */
export const ShellConstraintsSchema = z.object({
  timeout: z.number().default(30000).describe('Max execution time in milliseconds'),
  maxOutputSize: z.number().default(10485760).describe('Maximum output buffer in characters'),
  maxConcurrentShells: z.number().default(10).describe('Maximum shells running simultaneously'),
  allowedPaths: z.array(z.string()).default([]).describe('Directories the shell can access (empty = all)'),
  blockedCommands: z.array(z.string()).default([]).describe('Commands that are rejected outright'),
});

export type ShellConstraintsConfig = z.infer<typeof ShellConstraintsSchema>;
