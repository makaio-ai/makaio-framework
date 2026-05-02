/**
 * Per-client namespace factory.
 *
 * Concrete client packages call {@link createClientNamespace} once at module
 * load time to register their `client:<clientId>` bus namespace.  The factory
 * pre-registers the raw catch-all hook ingress subject (`hook.received`) using
 * the shared {@link RawClientHookPayloadSchema} so all client families expose a
 * consistent ingress point.
 *
 * Clients that need additional subjects beyond `hook.received` pass them via the
 * optional `additionalSchemas` parameter.  The resulting subjects object includes
 * both the shared `hook.received` subject and any extra subjects, fully typed.
 *
 * **Subject conventions:**
 * - Raw client-native data lives in `client:<id>.*` only — never in `client.*`.
 * - The global contract uses the term "observed semantics", not "hooks".
 * - Normalizers translate `client:<id>.hook.received` payloads into
 *   `client.session.*` events.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import type { SchemaRecord } from '@makaio/core';
import { canonicalizeClientId, RawClientHookPayloadSchema } from './client-session-observed-semantics.js';

/**
 * Result returned by {@link createClientNamespace}.
 * @typeParam AdditionalSchemas - Extra subject schemas registered alongside the
 *   shared `hook.received` subject.  Defaults to an empty record (no extras).
 */
export interface ClientNamespaceResult<AdditionalSchemas extends SchemaRecord = Record<never, never>> {
  /**
   * The fully-qualified bus namespace domain string (e.g. `'client:codex'`).
   */
  readonly namespaceDomain: string;
  /**
   * Typed bus subjects for the per-client namespace.
   *
   * Always includes `hook.received` for the raw catch-all hook ingress.
   * When `additionalSchemas` were provided at construction time the extra
   * subjects are also present here, fully typed.
   */
  readonly subjects: ReturnType<typeof buildClientSubjects<AdditionalSchemas>>;
}

/**
 * Build the subjects object for a per-client namespace.
 *
 * Extracted to a named generic function so the inferred return type is stable
 * and can be referenced by {@link ClientNamespaceResult} via instantiation
 * expressions.
 * @param clientId - Stable client identifier (e.g. `'codex'`)
 * @param additionalSchemas - Extra subjects to register alongside `hook.received`
 * @returns Namespace subjects with `hook.received` plus any additional subjects
 */
function buildClientSubjects<AdditionalSchemas extends SchemaRecord>(
  clientId: string,
  additionalSchemas: AdditionalSchemas,
) {
  const namespace = MakaioBus.registerNamespace(`client:${clientId}`, {
    'hook.received': RawClientHookPayloadSchema,
    ...additionalSchemas,
  });
  return namespace.subjects;
}

/**
 * Check whether a nested subject accessor exists on a namespace subjects object.
 * @param subjects - Subjects object returned from namespace registration.
 * @param subjectKey - Dotted subject key to verify, e.g. `'statusline.received'`.
 * @returns `true` when every path segment exists.
 */
function hasSubjectAccessor(subjects: unknown, subjectKey: string): boolean {
  let current: unknown = subjects;
  for (const segment of subjectKey.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

/**
 * Fail when an idempotent namespace registration returned an earlier, narrower
 * subject set that does not include the additional subjects requested now.
 * @param clientId - Normalized client identifier.
 * @param subjects - Subjects returned from the bus namespace registry.
 * @param additionalSchemas - Additional subject schemas requested by the caller.
 */
function assertAdditionalSubjectsRegistered(
  clientId: string,
  subjects: unknown,
  additionalSchemas: SchemaRecord,
): void {
  const missingSubjects = Object.keys(additionalSchemas).filter(
    (subjectKey) => !hasSubjectAccessor(subjects, subjectKey),
  );
  if (missingSubjects.length === 0) {
    return;
  }

  throw new Error(
    `[createClientNamespace] client:${clientId} was already registered without required subjects: ${missingSubjects.join(
      ', ',
    )}`,
  );
}

/**
 * Create (or retrieve) the per-client bus namespace for `client:<clientId>`.
 *
 * The namespace is registered idempotently — calling this function multiple
 * times with the same `clientId` returns equivalent subjects.
 *
 * The resulting namespace pre-registers the `hook.received` subject so client
 * ingress bridges have a consistent raw-event ingress point:
 *
 * ```ts
 * // In @makaio/client-codex
 * export const { subjects: CodexClientSubjects } = createClientNamespace('codex');
 * // CodexClientSubjects.hook.received → 'client:codex.hook.received'
 * ```
 *
 * Clients that need extra subjects pass them as the second argument:
 *
 * ```ts
 * // In @makaio/client-claude-code
 * export const { subjects } = createClientNamespace('claude-code', {
 *   'statusline.received': ClaudeCodeStatuslinePayloadSchema,
 * });
 * // subjects.statusline.received → 'client:claude-code.statusline.received'
 * ```
 * @param clientId - Stable client identifier (e.g. `'codex'`,
 *   `'claude-code'`), optionally prefixed with `client:`.  Canonicalized to
 *   lowercase and restricted to letters, numbers, and hyphens.
 * @param additionalSchemas - Optional extra subject schemas to register alongside
 *   the shared `hook.received` subject.
 * @returns Namespace domain string and typed bus subjects.
 */
export function createClientNamespace<AdditionalSchemas extends SchemaRecord = Record<never, never>>(
  clientId: string,
  additionalSchemas?: AdditionalSchemas,
): ClientNamespaceResult<AdditionalSchemas> {
  const normalizedClientId = canonicalizeClientId(clientId, 'createClientNamespace');

  const schemas = (additionalSchemas ?? {}) as AdditionalSchemas;
  const subjects = buildClientSubjects(normalizedClientId, schemas);
  assertAdditionalSubjectsRegistered(normalizedClientId, subjects, schemas);

  return {
    namespaceDomain: `client:${normalizedClientId}`,
    subjects,
  };
}
