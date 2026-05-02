/**
 * Per-client wiring subject builders for the client-commands CLI extension.
 *
 * Provides non-owning typed {@link SubjectDefinition} factories for the
 * `wiring.apply` and `wiring.remove` subjects in per-client namespaces.
 * These are intentionally **not** namespace registrations — each concrete
 * client package owns its full `client:<id>` namespace.
 * @packageDocumentation
 */

import type { RequestMessagePayload, SubjectDefinition, SubjectRecord } from '@makaio/core';
import type { ClientWiringApplyResponse, ClientWiringRemoveResponse } from '@makaio/clients-core';
import { createClientWiringSubjectDef } from '@makaio/clients-core';

// ---------------------------------------------------------------------------
// wiring.apply
// ---------------------------------------------------------------------------

/**
 * Typed payload for the per-client `wiring.apply` request/response pair.
 *
 * The request carries `scope` (required), optional `projectDir`, and required
 * `makaioCommand`. The response reports how many entries were applied vs
 * skipped.
 *
 * The `scope` field is intentionally typed as `string` (not a discriminated
 * enum) so the CLI bridge can forward user-supplied values without coupling to
 * a specific client's scope enum.
 */
type ClientWiringApplyPayload = RequestMessagePayload<
  { scope: string; projectDir?: string; makaioCommand: string },
  ClientWiringApplyResponse
>;

type ClientWiringApplySubjectRecord = SubjectRecord<'wiring.apply', ClientWiringApplyPayload>;

/**
 * Non-owning typed {@link SubjectDefinition} for `client:<id>.wiring.apply`.
 */
export type ClientWiringApplySubjectDef = SubjectDefinition<
  ClientWiringApplySubjectRecord,
  'wiring.apply',
  `client:${string}`
>;

// ---------------------------------------------------------------------------
// wiring.remove
// ---------------------------------------------------------------------------

/**
 * Typed payload for the per-client `wiring.remove` request/response pair.
 *
 * The request carries `scope` (required) and optional `projectDir`. The
 * response reports how many entries were removed.
 */
type ClientWiringRemovePayload = RequestMessagePayload<
  { scope: string; projectDir?: string },
  ClientWiringRemoveResponse
>;

type ClientWiringRemoveSubjectRecord = SubjectRecord<'wiring.remove', ClientWiringRemovePayload>;

/**
 * Non-owning typed {@link SubjectDefinition} for `client:<id>.wiring.remove`.
 */
export type ClientWiringRemoveSubjectDef = SubjectDefinition<
  ClientWiringRemoveSubjectRecord,
  'wiring.remove',
  `client:${string}`
>;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.wiring.apply`.
 *
 * This is intentionally **not** a namespace registration. Concrete client
 * packages own their full `client:<id>` namespace; the CLI bridge only needs
 * to dispatch the apply request without registering a conflicting namespace.
 * @param clientId - Stable client identifier (e.g. `'claude-code'`, `'codex'`),
 *   optionally prefixed with `client:`.
 * @returns Non-owning typed subject definition for the per-client wiring apply.
 */
export function createClientWiringApplySubjectDef(clientId: string): ClientWiringApplySubjectDef {
  return createClientWiringSubjectDef(clientId, 'wiring.apply') as ClientWiringApplySubjectDef;
}

/**
 * Build a non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.wiring.remove`.
 *
 * This is intentionally **not** a namespace registration. Concrete client
 * packages own their full `client:<id>` namespace; the CLI bridge only needs
 * to dispatch the remove request without registering a conflicting namespace.
 * @param clientId - Stable client identifier (e.g. `'claude-code'`, `'codex'`),
 *   optionally prefixed with `client:`.
 * @returns Non-owning typed subject definition for the per-client wiring remove.
 */
export function createClientWiringRemoveSubjectDef(clientId: string): ClientWiringRemoveSubjectDef {
  return createClientWiringSubjectDef(clientId, 'wiring.remove') as ClientWiringRemoveSubjectDef;
}
