import { createBusNamespace } from '@makaio/core';
import { WorkerSettingsSchemas } from '../worker/schemas.js';
import { SettingsSchemas, AdapterInfoSchema } from './schemas.js';
import { ExtensionConfigStorageSubjects } from './storage/extension-configs/namespace.js';

/**
 * Settings namespace for WebUI CRUD operations.
 *
 * Provides bus subjects for managing:
 * - Runtime configuration
 * - Adapter driver enablement
 * - Adapter-level defaults
 * - Per-adapter instance configurations
 *
 * Prefix: 'settings.'
 */
export const SettingsNamespace = createBusNamespace('settings', SettingsSchemas);

/** Pre-extracted subjects for direct import. */
export const SettingsSubjects = SettingsNamespace.subjects;

/**
 * Worker settings namespace for worker definition CRUD.
 * Exposed for clients (e.g., WorkerService) to make typed RPC calls without registering the namespace themselves.
 */
export const WorkerSettingsNamespace = createBusNamespace('settings:worker', WorkerSettingsSchemas);
export const WorkerSettingsSubjects = WorkerSettingsNamespace.subjects;

// ── Re-exported bus subjects and data contracts for external consumers ─────────

export { AdapterInfoSchema };
export { ExtensionConfigStorageSubjects };
