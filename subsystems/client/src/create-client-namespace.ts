/**
 * Per-client namespace factory.
 *
 * Concrete client packages call {@link createClientNamespace} once at module
 * load time to register their `client:<clientId>` bus namespace.  The factory
 * pre-registers the shared hook subjects (`hook.received` and `hook.handle`) so
 * all client families expose consistent hook ingress and request handling points.
 *
 * Clients that need subjects beyond those shared hook subjects pass them via the
 * optional `additionalSchemas` parameter.  The resulting subjects object includes
 * both shared hook subjects and any extra subjects, fully typed.
 *
 * **Subject conventions:**
 * - Raw client-native data lives in `client:<id>.*` only — never in `client.*`.
 * - The global contract uses the term "observed semantics", not "hooks".
 * - Normalizers translate `client:<id>.hook.received` payloads into
 *   `client.session.*` events.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { createBusNamespace, hostLocalRequest, type SchemaRecord } from '@makaio/core';
import {
  canonicalizeClientId,
  ClientHookHandleResponseSchema,
  RawClientHookPayloadSchema,
} from './client-session-observed-semantics.js';

const RESERVED_CLIENT_HOOK_SUBJECTS = new Set(['hook.received', 'hook.handle']);

/**
 * Result returned by {@link createClientNamespace}.
 * @typeParam AdditionalSchemas - Extra subject schemas registered alongside the
 *   shared hook subjects.  Defaults to an empty record (no extras).
 */
export interface ClientNamespaceResult<AdditionalSchemas extends SchemaRecord = Record<never, never>> {
  /**
   * The fully-qualified bus namespace domain string (e.g. `'client:codex'`).
   */
  readonly namespaceDomain: string;
  /**
   * Typed bus subjects for the per-client namespace.
   *
   * Always includes `hook.received` for raw hook ingress and `hook.handle` for
   * hook request handling.
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
 * @param additionalSchemas - Extra subjects to register alongside the shared
 *   hook subjects.
 * @returns Namespace subjects with shared hook subjects plus any additional
 *   subjects.
 */
function buildClientSubjects<AdditionalSchemas extends SchemaRecord>(
  clientId: string,
  additionalSchemas: AdditionalSchemas,
) {
  const namespace = MakaioBus.registerNamespace(
    createBusNamespace(`client:${clientId}`, {
      'hook.received': RawClientHookPayloadSchema,
      'hook.handle': hostLocalRequest({
        request: RawClientHookPayloadSchema,
        response: ClientHookHandleResponseSchema,
      }),
      ...additionalSchemas,
    }),
  );
  return namespace.subjects;
}

/**
 * Reject attempts to redefine shared hook subjects.
 *
 * `hook.received` and `hook.handle` are universal bridge contracts. Concrete
 * client packages own additional subjects in their namespace, but these two
 * shared subjects must keep the same schemas for every client.
 * @param clientId - Normalized client identifier.
 * @param additionalSchemas - Additional subject schemas requested by the caller.
 */
function assertNoReservedSubjectOverrides(clientId: string, additionalSchemas: SchemaRecord): void {
  const collisions = Object.keys(additionalSchemas).filter((subjectKey) =>
    RESERVED_CLIENT_HOOK_SUBJECTS.has(subjectKey),
  );
  if (collisions.length === 0) {
    return;
  }

  const collisionList = collisions.join(', ');
  throw new Error(
    [
      `[createClientNamespace] additionalSchemas for client:${clientId}`,
      `cannot override reserved shared hook subjects: ${collisionList}`,
    ].join(' '),
  );
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
 * The resulting namespace pre-registers the `hook.received` and `hook.handle`
 * subjects so client bridges have consistent hook ingress and request handling
 * points:
 *
 * ```ts
 * // In @makaio/client-codex
 * export const { subjects: CodexClientSubjects } = createClientNamespace('codex');
 * // CodexClientSubjects.hook.received → 'client:codex.hook.received'
 * // CodexClientSubjects.hook.handle → 'client:codex.hook.handle'
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
 *   the shared hook subjects.  Must not include `hook.received` or `hook.handle`.
 * @returns Namespace domain string and typed bus subjects.
 */
export function createClientNamespace<AdditionalSchemas extends SchemaRecord = Record<never, never>>(
  clientId: string,
  additionalSchemas?: AdditionalSchemas,
): ClientNamespaceResult<AdditionalSchemas> {
  const normalizedClientId = canonicalizeClientId(clientId, 'createClientNamespace');

  const schemas = (additionalSchemas ?? {}) as AdditionalSchemas;
  assertNoReservedSubjectOverrides(normalizedClientId, schemas);
  const subjects = buildClientSubjects(normalizedClientId, schemas);
  assertAdditionalSubjectsRegistered(normalizedClientId, subjects, schemas);

  return {
    namespaceDomain: `client:${normalizedClientId}`,
    subjects,
  };
}
