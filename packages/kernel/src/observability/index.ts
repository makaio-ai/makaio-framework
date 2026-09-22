/**
 * Observability barrel export.
 *
 * Provides shared schemas plus the `kernel:extension.*` bus namespace.
 */
export {
  ComponentStateSchema,
  ComponentIdentitySchema,
  ComponentInfoSchema,
  ExtensionWarningEntrySchema,
  ServiceInfoSchema,
  ExtensionInfoSchema,
} from './shared-schemas.js';
export type {
  ComponentState,
  ComponentInfo,
  ExtensionWarningEntry,
  ServiceInfo,
  ExtensionInfo,
} from './shared-schemas.js';
export {
  ExtensionNamespace,
  ExtensionSubjects,
  SetEnabledReasonSchema,
  TransitionOutcomeSchema,
} from './extension-namespace.js';
export type { SetEnabledReason, TransitionOutcome } from './extension-namespace.js';
export {
  InstalledExtensionOriginSchema,
  InstalledExtensionRecordSchema,
  InstalledExtensionCatalogEntrySchema,
} from './installed-extension-catalog-schemas.js';
export type {
  InstalledExtensionOrigin,
  InstalledExtensionRecord,
  InstalledExtensionCatalogEntry,
} from './installed-extension-catalog-schemas.js';
