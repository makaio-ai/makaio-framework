/**
 * Browser-safe exports for client-side usage.
 *
 * This module exports only types — no Node.js built-ins (`node:fs`, `node:path`,
 * `node:crypto`) are reachable from this entrypoint.
 *
 * Use `@makaio/services-log-import/browser` in browser code instead of
 * `@makaio/services-log-import` to avoid bundling Node.js dependencies.
 * @packageDocumentation
 */

export type {
  LogImporterRegistration,
  LogImportRegistryOptions,
  OrchestratorEntry,
  OrchestratorFactory,
} from './types.js';
export type { LogImporterInfo } from './schemas/index.js';
