/**
 * CLI bus namespace definition.
 *
 * Defines the `kernel:cli` namespace subjects. Subjects are
 * accessed via {@link CliRpcSubjects} (e.g. `CliRpcSubjects.listContributions`).
 *
 * Named `CliRpcSubjects` (not `CliSubjects`) to avoid collision with the
 * existing `CliSubjects` type export if one exists, and to clarify these
 * are bus RPC subjects, not CLI type definitions.
 */
import { createBusNamespace } from '@makaio/core';
import { CliSchemas } from './schemas.js';

/** CLI bus namespace — `cli.*` subjects. */
export const CliNamespace = createBusNamespace('kernel:cli', CliSchemas);

/**
 * Typed subjects for CLI RPC operations.
 *
 * - `CliRpcSubjects.listContributions` — discover extension CLI commands
 * - `CliRpcSubjects.execute` — run a subcommand on the server
 */
export const CliRpcSubjects = CliNamespace.subjects;
