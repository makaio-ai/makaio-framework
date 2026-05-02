/**
 * Log-import bus subjects and mode type.
 *
 * Convenience re-export for consumers that need `LogImportSubjects` alongside
 * the shared log-import types.
 *
 * Importing this entrypoint does load `./namespace.ts`, so it intentionally
 * keeps the namespace registration side effect for runtime callers that need
 * the subject values. Type-only consumers should import the schema/type
 * modules directly instead.
 * @packageDocumentation
 */
export { LogImportSubjects } from './namespace.js';
export type { LogImportMode } from './schemas/mode.js';
export type { LogImporterInfo } from './schemas/index.js';
export { IMPORT_LAST_SCAN_CATEGORY } from './schemas/settings.js';
