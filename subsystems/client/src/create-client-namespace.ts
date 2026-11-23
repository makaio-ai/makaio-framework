/**
 * Per-client namespace factory.
 *
 * Concrete client packages call {@link createClientNamespace} once at module
 * load time to define their `client:<clientId>` bus namespace.  The factory is
 * pure: it registers nothing.  The runtime manifest declares the returned
 * {@link ClientNamespaceResult.definition | definition} in `namespaces`, and the
 * extension coordinator registers it on load.  The factory pre-defines the shared hook subjects (`hook.received` and `hook.handle`) so
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

import { createBusNamespace, hostLocalRequest, type SchemaRecord } from '@makaio/core';
import { canonicalizeClientId, ClientHookHandleResponseSchema, RawClientHookPayloadSchema } from './hook-subjects.js';

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
   * The namespace definition, to be declared in the runtime manifest's
   * `namespaces` so the extension coordinator registers it on load.
   */
  readonly definition: ReturnType<typeof buildClientDefinition<AdditionalSchemas>>;
  /**
   * Typed bus subjects for the per-client namespace.
   *
   * Always includes `hook.received` for raw hook ingress and `hook.handle` for
   * hook request handling.
   * When `additionalSchemas` were provided at construction time the extra
   * subjects are also present here, fully typed.
   */
  readonly subjects: ReturnType<typeof buildClientDefinition<AdditionalSchemas>>['subjects'];
}

/**
 * Build the namespace definition for a per-client namespace.
 *
 * Extracted to a named generic function so the inferred return type is stable
 * and can be referenced by {@link ClientNamespaceResult} via instantiation
 * expressions.  Pure: nothing is registered on any bus.
 * @param clientId - Stable client identifier (e.g. `'codex'`)
 * @param additionalSchemas - Extra subjects to define alongside the shared
 *   hook subjects.
 * @returns Namespace definition with shared hook subjects plus any additional
 *   subjects.
 */
function buildClientDefinition<AdditionalSchemas extends SchemaRecord>(
  clientId: string,
  additionalSchemas: AdditionalSchemas,
) {
  return createBusNamespace(`client:${clientId}`, {
    'hook.received': RawClientHookPayloadSchema,
    'hook.handle': hostLocalRequest({
      request: RawClientHookPayloadSchema,
      response: ClientHookHandleResponseSchema,
    }),
    ...additionalSchemas,
  });
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
 * Define the per-client bus namespace for `client:<clientId>`.
 *
 * Pure: the factory registers nothing.  Declare the returned `definition` in
 * the runtime manifest's `namespaces`; the extension coordinator registers it
 * on load, before `create`.
 *
 * The resulting namespace pre-defines the `hook.received` and `hook.handle`
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
 * @returns Namespace domain string, namespace definition and typed bus subjects.
 */
export function createClientNamespace<AdditionalSchemas extends SchemaRecord = Record<never, never>>(
  clientId: string,
  additionalSchemas?: AdditionalSchemas,
): ClientNamespaceResult<AdditionalSchemas> {
  const normalizedClientId = canonicalizeClientId(clientId, 'createClientNamespace');

  const schemas = (additionalSchemas ?? {}) as AdditionalSchemas;
  assertNoReservedSubjectOverrides(normalizedClientId, schemas);
  const definition = buildClientDefinition(normalizedClientId, schemas);

  return {
    namespaceDomain: `client:${normalizedClientId}`,
    definition,
    subjects: definition.subjects,
  };
}
