/**
 * Preferences namespace definition.
 *
 * Import `./schemas` when you only need pure Zod contracts without bus
 * subject helpers. Composition roots register this namespace explicitly.
 * @packageDocumentation
 */
import { createBusNamespace } from '@makaio/core';
import { PreferenceKeySchema, PreferenceValueSchema, PreferenceItemSchema, PreferencesSchemas } from './schemas.js';

// Re-export schemas and types so existing runtime imports keep working while the
// pure-schema seam lives in `./schemas`.
export type { PreferenceKey, PreferenceItem } from './schemas.js';
export { PreferenceKeySchema, PreferenceValueSchema, PreferenceItemSchema, PreferencesSchemas };

/**
 * Preferences namespace definition.
 */
export const PreferencesNamespace = createBusNamespace('preferences', PreferencesSchemas);

/**
 * Preferences subjects for bus communication.
 */
export const PreferencesSubjects = PreferencesNamespace.subjects;
