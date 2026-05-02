/**
 * CLI bus namespace schemas.
 *
 * Defines RPC subjects for CLI command discovery and remote execution.
 * The CLI binary uses these to discover extension commands from a running
 * server and dispatch subcommand invocations without loading handler code
 * locally.
 */
import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { CliManifestSchema } from '@makaio/contracts/extension';

/**
 * CLI namespace schema definitions.
 *
 * Both subjects are request/response RPCs — no fire-and-forget events.
 */
export const CliSchemas = {
  /**
   * List all CLI contributions from loaded extensions.
   *
   * Returns CLI manifest objects (serializable metadata only, no
   * handler code). The CLI uses this to register remote commands and
   * generate `--help` output.
   */
  listContributions: {
    request: z.object({}),
    response: z.object({
      /** CLI manifests from all loaded extensions with CLI contributions. */
      contributions: z.array(CliManifestSchema),
    }),
  },

  /**
   * Execute a CLI subcommand on the server.
   *
   * The server validates args through the subcommand's Zod schema, runs the
   * handler with a buffering output writer, and returns captured output.
   */
  execute: {
    request: z.object({
      /** Top-level command name (e.g. `'account-manager'`). */
      command: z.string().min(1),
      /** Subcommand name (e.g. `'list'`). */
      subcommand: z.string().min(1),
      /** Raw arguments to validate through the subcommand's Zod schema. */
      args: z.record(z.string(), z.unknown()).optional(),
    }),
    response: z.object({
      /** Process exit code (0 = success). */
      exitCode: z.number(),
      /** Lines written to stdout by the handler. */
      stdout: z.array(z.string()),
      /** Lines written to stderr by the handler. */
      stderr: z.array(z.string()),
    }),
  },
} satisfies SchemaRecord;
