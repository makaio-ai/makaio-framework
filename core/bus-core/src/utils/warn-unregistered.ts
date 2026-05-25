import type { SubjectDefinition } from '@makaio/core';
import type { MakaioBusContext } from '../types/index.js';

const warned = new Set<string>();

/**
 * Emit a one-time console warning when a bus operation targets a subject
 * whose namespace is not registered in the runtime registry.
 *
 * Missing registration silently disables payload validation,
 * `isLocalSubject()` routing guards, and `extendSubject()`. This warning
 * surfaces the gap in dev/test so it is caught before production.
 * @param context - Active bus context with the namespace registry
 * @param subjectDefinition - Subject targeted by the bus operation
 * @param fullKey - Pre-computed fully-qualified subject key (avoids recomputation when the caller already has it)
 */
export function warnIfUnregistered(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  fullKey: string,
): void {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env['MAKAIO_DEBUG'] !== 'true') return;

  if (subjectDefinition.subject.includes('*')) return;
  if (subjectDefinition.$meta.namespace.startsWith('channel:')) return;

  // Registered subjects are the steady-state — check the authoritative map first.
  const schema = context.namespaceRegistry.getSchema(fullKey);
  if (schema !== undefined) return;

  // Deduplicate: one warning per subject key per process.
  if (warned.has(fullKey)) return;
  warned.add(fullKey);

  const namespace = subjectDefinition.$meta.namespace;
  console.warn(
    `[MakaioBus] Subject '${fullKey}' used but namespace '${namespace}' ` +
      `is not registered. Validation and local-subject routing are disabled. ` +
      `Call registerNamespace() at boot.`,
  );
}

/**
 * Reset the warned-subjects set between test runs.
 * @internal
 * @returns Reset function in test mode, undefined otherwise
 */
export const __resetWarnedSubjects = process.env.NODE_ENV === 'test' ? () => warned.clear() : undefined;
