/**
 * CLI bus namespace registration.
 *
 * Registers the `cli` top-level namespace with the bus. Subjects are
 * accessed via {@link CliRpcSubjects} (e.g. `CliRpcSubjects.listContributions`).
 *
 * Named `CliRpcSubjects` (not `CliSubjects`) to avoid collision with the
 * existing `CliSubjects` type export if one exists, and to clarify these
 * are bus RPC subjects, not CLI type definitions.
 */
import { MakaioBus } from '@makaio/bus-core';
import { CliSchemas } from './schemas.js';

/** CLI bus namespace — `cli.*` subjects. */
export const CliNamespace = MakaioBus.registerNamespace('kernel:cli', CliSchemas);

/**
 * Typed subjects for CLI RPC operations.
 *
 * - `CliRpcSubjects.listContributions` — discover extension CLI commands
 * - `CliRpcSubjects.execute` — run a subcommand on the server
 */
export const CliRpcSubjects = CliNamespace.subjects;
