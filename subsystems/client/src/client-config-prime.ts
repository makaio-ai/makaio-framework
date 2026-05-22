/**
 * Shared helper for the generic `client.config.prime` lifecycle delegation.
 *
 * The `client.config.prime` subject is a framework-level hook fired at three
 * lifecycle phases:
 *
 * - `'managed-install'` — after a managed binary is verified.
 * - `'profile-create'`  — after a named profile directory is created.
 * - `'session-create'`  — after a session config directory is populated.
 *
 * Each invocation delegates to the per-client `client:<clientId>.config.prime`
 * subject via `requestOptional`.  When no client-specific handler is registered
 * the call is a silent no-op so the framework never blocks on unregistered
 * clients.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientConfigPrimeRequest, ClientConfigPrimeResponse } from '@makaio/contracts/client';
import type { RequestMessagePayload, SubjectDefinition, SubjectRecord } from '@makaio/core';

// ---------------------------------------------------------------------------
// Non-owning per-client subject definition
// ---------------------------------------------------------------------------

/** Payload type for the per-client `config.prime` request/response pair. */
type ClientConfigPrimePayload = RequestMessagePayload<ClientConfigPrimeRequest, ClientConfigPrimeResponse>;

type ClientConfigPrimeSubjectRecord = SubjectRecord<'config.prime', ClientConfigPrimePayload>;

/**
 * Non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.config.prime`.
 *
 * Follows the same non-owning pattern as the session-config setup delegation:
 * the concrete client package owns its full `client:<id>` namespace while this
 * module dispatches without registering a conflicting namespace.
 */
type ClientConfigPrimeSubjectDef = SubjectDefinition<
  ClientConfigPrimeSubjectRecord,
  'config.prime',
  `client:${string}`
>;

/**
 * Build a non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.config.prime`.
 * @param clientId - Stable client identifier (already canonicalized).
 * @returns Non-owning typed subject definition for the per-client prime subject.
 */
function createClientConfigPrimeSubjectDef(clientId: string): ClientConfigPrimeSubjectDef {
  return {
    subject: 'config.prime',
    $meta: {
      namespace: `client:${clientId}`,
      isRequest: true,
      local: false,
      channel: false,
    },
  } as ClientConfigPrimeSubjectDef;
}

// ---------------------------------------------------------------------------
// Public delegation helper
// ---------------------------------------------------------------------------

/**
 * Invoke the per-client `client:<clientId>.config.prime` handler via
 * `requestOptional`.
 *
 * This call is **blocking** — callers must `await` it before continuing with
 * any lifecycle step that depends on the primed config directory.  When no
 * client-specific handler is registered the promise resolves immediately as a
 * no-op.
 * @param bus - Bus instance to dispatch on.
 * @param payload - Config prime request payload.
 * @returns Prime response from the client-specific handler, or `{ primed: false }`
 *   when no handler is registered.
 */
export async function primeClientConfig(
  bus: IMakaioBus,
  payload: ClientConfigPrimeRequest,
): Promise<ClientConfigPrimeResponse> {
  const result = await bus.requestOptional(createClientConfigPrimeSubjectDef(payload.clientId), payload);
  return result.handled ? result.data : { primed: false };
}
