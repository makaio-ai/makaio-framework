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
export { ExtensionNamespace, ExtensionSubjects, TransitionOutcomeSchema } from './extension-namespace.js';
export type { TransitionOutcome } from './extension-namespace.js';
