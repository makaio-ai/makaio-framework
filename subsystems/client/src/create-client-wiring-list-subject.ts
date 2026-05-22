/**
 * Per-client wiring subject builder helpers.
 *
 * Provides the shared {@link createClientWiringSubjectDef} primitive and the
 * concrete typed factory for `client:<id>.wiring.list`.  The generic primitive
 * is also consumed by the `client-commands` CLI extension to build the
 * `wiring.apply` and `wiring.remove` subject definitions, avoiding duplicated
 * `$meta` construction across all three builders.
 *
 * Individual client packages own their full `client:<id>` namespace.  These
 * builders are intentionally **not** namespace registrations — they produce
 * non-owning subject definitions so callers can dispatch without registering a
 * conflicting namespace before the concrete owner loads.
 * @packageDocumentation
 */

import type { RequestMessagePayload, SubjectDefinition, SubjectRecord } from '@makaio/core';
import { canonicalizeClientId } from './client-session-observed-semantics.js';
import type { ClientWiringEntry } from './wiring-schemas.js';

// ---------------------------------------------------------------------------
// Shared primitive
// ---------------------------------------------------------------------------

/** Untyped wiring subject definition returned by {@link createClientWiringSubjectDef}. */
export interface ClientWiringSubjectDefBase {
  /** Subject key within the client namespace (e.g. `'wiring.list'`). */
  subject: string;
  /** Standard `$meta` applied to all per-client wiring subjects. */
  $meta: {
    /** Resolved `client:<id>` namespace for this subject. */
    namespace: string;
    /** Always `true` — wiring subjects are request/response pairs. */
    isRequest: true;
    /** Always `false` — wiring subjects are not local-only. */
    local: false;
    /** Always `false` — wiring subjects are not channels. */
    channel: false;
  };
}

/**
 * Build a non-owning typed subject definition for any per-client wiring
 * subject.
 *
 * Encapsulates the standard `$meta` structure shared by all
 * `client:<id>.wiring.*` subjects: `isRequest: true`, `local: false`,
 * `channel: false`.  The `clientId` is canonicalized via
 * {@link canonicalizeClientId} so callers need not normalize the input.
 *
 * This helper returns a plain object — callers cast it to their concrete
 * {@link SubjectDefinition} type exactly as `createRawClientHookReceivedSubject`
 * does.
 * @param clientId - Stable client identifier, optionally prefixed with `client:`.
 * @param subjectSuffix - Subject key within the namespace (e.g. `'wiring.list'`).
 * @returns Plain subject definition object ready to be cast to the concrete type.
 */
export function createClientWiringSubjectDef(clientId: string, subjectSuffix: string): ClientWiringSubjectDefBase {
  const normalized = canonicalizeClientId(clientId, 'createClientWiringSubjectDef');
  return {
    subject: subjectSuffix,
    $meta: {
      namespace: `client:${normalized}`,
      isRequest: true,
      local: false,
      channel: false,
    },
  };
}

// ---------------------------------------------------------------------------
// wiring.list
// ---------------------------------------------------------------------------

/**
 * Typed payload for the per-client `wiring.list` request/response pair.
 *
 * The request accepts an optional `projectDir` and `makaioCommand` — the
 * same optional filtering fields supported by all known client wiring
 * implementations.  The response carries an `entries` array.
 */
type ClientWiringListPayload = RequestMessagePayload<
  { projectDir?: string; makaioCommand: string },
  { entries: ClientWiringEntry[] }
>;

type ClientWiringListSubjectRecord = SubjectRecord<'wiring.list', ClientWiringListPayload>;

/**
 * Non-owning typed {@link SubjectDefinition} for `client:<id>.wiring.list`.
 */
export type ClientWiringListSubjectDef = SubjectDefinition<
  ClientWiringListSubjectRecord,
  'wiring.list',
  `client:${string}`
>;

/**
 * Build a non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.wiring.list`.
 *
 * This is intentionally **not** a namespace registration.  Concrete client
 * packages own their full `client:<id>` namespace; the aggregator only needs
 * to dispatch the list request without registering a conflicting namespace.
 * When the concrete owner is loaded, normal bus schema validation applies;
 * when it is not, the ad-hoc subject still dispatches locally.
 * @param clientId - Stable client identifier (e.g. `'claude-code'`,
 *   `'codex'`), optionally prefixed with `client:`.
 * @returns Non-owning typed subject definition for the per-client wiring list.
 */
export function createClientWiringListSubjectDef(clientId: string): ClientWiringListSubjectDef {
  return createClientWiringSubjectDef(clientId, 'wiring.list') as ClientWiringListSubjectDef;
}
