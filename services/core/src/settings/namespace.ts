import { createBusNamespace } from '@makaio/core';
import { SubagentTemplateSettingsSchemas } from '../subagent-template/schemas.js';
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
 * SubagentTemplate settings namespace for subagent template definition CRUD.
 * Exposed for clients (e.g., SubagentTemplateService) to make typed RPC calls
 * without registering the namespace themselves.
 */
export const SubagentTemplateSettingsNamespace = createBusNamespace(
  'settings:subagentTemplate',
  SubagentTemplateSettingsSchemas,
);
export const SubagentTemplateSettingsSubjects = SubagentTemplateSettingsNamespace.subjects;

// ── Re-exported bus subjects and data contracts for external consumers ─────────

export { AdapterInfoSchema };
export { ExtensionConfigStorageSubjects };
