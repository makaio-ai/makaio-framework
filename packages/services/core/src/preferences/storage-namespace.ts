/**
 * Preferences namespace registration — has side effects (registers on the bus).
 *
 * Import `./schemas` when you only need pure Zod contracts without bus
 * registration. This file exists for runtime callers that need
 * `PreferencesSubjects` at execution time.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';
import { PreferenceKeySchema, PreferenceValueSchema, PreferenceItemSchema, PreferencesSchemas } from './schemas.js';

// Re-export schemas and types so existing runtime imports keep working while the
// pure-schema seam lives in `./schemas`.
export type { PreferenceKey, PreferenceItem } from './schemas.js';
export { PreferenceKeySchema, PreferenceValueSchema, PreferenceItemSchema, PreferencesSchemas };

/**
 * Preferences namespace registered with the bus.
 */
export const PreferencesNamespace = MakaioBus.registerNamespace('preferences', PreferencesSchemas);

/**
 * Preferences subjects for bus communication.
 */
export const PreferencesSubjects = PreferencesNamespace.subjects;
