import type { IMakaioBus } from '@makaio/bus-core';
import {
  ClientAccountIdentifierSchema,
  ClientSubjects,
  type ClientAccountObserveRequest,
  type ClientAccountIdentifier,
  type ClientIdentityObservation,
  type ClientSessionAccountObserveRequest,
  type ClientSessionAccountObserveResponse,
} from '@makaio/contracts/client';
import { z } from 'zod';
import { SessionStorageSubjects } from '../storage/namespace.js';
import type {
  DerivedClientAccountObservation,
  ResolvedClientObservationSession,
  SessionClientAccountObserveHandler,
} from './types.js';

/**
 * Build the session-scoped account-observation handler.
 * @param bus - Bus instance used for storage lookups and account resolution
 * @returns Request handler for `client.session.account.observe`
 */
export function createSessionClientAccountObserveHandler(bus: IMakaioBus): SessionClientAccountObserveHandler {
  return async (payload): Promise<ClientSessionAccountObserveResponse> => {
    const resolvedSession = await resolveObservedSession(bus, payload);
    if (!resolvedSession) {
      return {
        handled: false,
        sessionId: null,
        clientAccountId: null,
        changed: false,
      };
    }

    const { sessionId } = resolvedSession;
    const { observation, accountObserveRequest } = deriveClientAccountObservation(payload);
    const accountObserveResult = await bus.requestOptional(ClientSubjects.account.observe, accountObserveRequest);
    if (!accountObserveResult.handled) {
      return {
        handled: false,
        sessionId,
        clientAccountId: null,
        changed: false,
      };
    }

    const { clientAccountId } = accountObserveResult.data;
    const changed = await persistClientAccountObservation(bus, sessionId, observation, clientAccountId);

    return {
      handled: true,
      sessionId,
      clientAccountId,
      changed,
    };
  };
}

/**
 * Resolve the target session from the observation locator.
 * @param bus - Bus instance used for storage lookups
 * @param payload - Session-scoped client account observation request
 * @returns Resolved session, or `null` when neither locator finds one
 */
export async function resolveObservedSession(
  bus: IMakaioBus,
  payload: ClientSessionAccountObserveRequest,
): Promise<ResolvedClientObservationSession | null> {
  switch (payload.locator.kind) {
    case 'session': {
      const { session } = await bus.request(SessionStorageSubjects.get, {
        sessionId: payload.locator.sessionId,
      });
      return session ? { sessionId: session.sessionId, session } : null;
    }
    case 'adapter-session': {
      const { session } = await bus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: payload.locator.adapterSessionId,
      });
      return session ? { sessionId: session.sessionId, session } : null;
    }
    case 'both': {
      const [{ session: bySessionId }, { session: byAdapterSessionId }] = await Promise.all([
        bus.request(SessionStorageSubjects.get, {
          sessionId: payload.locator.sessionId,
        }),
        bus.request(SessionStorageSubjects.getByAdapterSessionId, {
          adapterSessionId: payload.locator.adapterSessionId,
        }),
      ]);

      if (!bySessionId && !byAdapterSessionId) {
        return null;
      }

      if (!bySessionId || !byAdapterSessionId) {
        throw new Error(
          `Session locator mismatch: sessionId "${payload.locator.sessionId}" and adapterSessionId "${payload.locator.adapterSessionId}" must both resolve the same session`,
        );
      }

      if (bySessionId.sessionId !== byAdapterSessionId.sessionId) {
        throw new Error(
          `Session locator mismatch: sessionId "${payload.locator.sessionId}" and adapterSessionId "${payload.locator.adapterSessionId}" resolve to different sessions`,
        );
      }

      return { sessionId: bySessionId.sessionId, session: bySessionId };
    }
  }
}

/**
 * Normalize the session-scoped observation into a clients-core account observation request.
 * @param payload - Session-scoped observation request
 * @returns Derived raw observation and canonical `client.account.observe` request
 */
export function deriveClientAccountObservation(
  payload: ClientSessionAccountObserveRequest,
): DerivedClientAccountObservation {
  const observation = {
    clientId: payload.clientId,
    source: payload.source,
    kind: payload.kind,
    observedAt: payload.observedAt,
    payload: cloneRecord(payload.payload),
  } satisfies ClientIdentityObservation;

  const accountObserveRequest = buildClientAccountObserveRequest(observation);

  return {
    observation,
    accountObserveRequest,
  };
}

/**
 * Build the canonical `client.account.observe` request from a raw observation.
 * @param observation - Normalized client identity observation
 * @returns Request payload forwarded to the client account resolver
 */
function buildClientAccountObserveRequest(observation: ClientIdentityObservation): ClientAccountObserveRequest {
  const payload = observation.payload;
  const sourcePayload = getIdentitySourcePayload(payload);
  const identifiers = getProvidedIdentifiers(payload);

  if (identifiers.length > 0) {
    return {
      clientId: observation.clientId,
      observedAt: observation.observedAt,
      displayLabel: resolveDisplayLabel(payload, sourcePayload),
      identifiers,
    };
  }

  throw new Error(
    `client.session.account.observe for "${observation.clientId}" requires canonical client account identifiers`,
  );
}

/**
 * Resolve the nested account payload when the client reports one.
 * @param payload - Raw observation payload
 * @returns Nested account payload, or the original payload when no nested record exists
 */
function getIdentitySourcePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(payload['accountInfo']);
  return nested ?? payload;
}

/**
 * Parse explicitly supplied identifiers from the observation payload.
 * @param payload - Raw observation payload
 * @returns Canonical identifiers accepted by the client contracts
 */
function getProvidedIdentifiers(payload: Record<string, unknown>): ClientAccountIdentifier[] {
  const rawIdentifiers = payload['identifiers'];
  if (!Array.isArray(rawIdentifiers)) {
    return [];
  }

  try {
    return z.array(ClientAccountIdentifierSchema).min(1).parse(rawIdentifiers);
  } catch (error) {
    throw new Error('client.session.account.observe received malformed canonical client account identifiers', {
      cause: error,
    });
  }
}

/**
 * Choose the best display label to persist for the observation.
 * @param payload - Top-level observation payload
 * @param sourcePayload - Nested source payload after accountInfo normalization
 * @returns Human-readable display label when present
 */
function resolveDisplayLabel(
  payload: Record<string, unknown>,
  sourcePayload: Record<string, unknown>,
): string | undefined {
  return (
    normalizeString(payload['displayLabel']) ??
    normalizeString(sourcePayload['displayLabel']) ??
    normalizeString(sourcePayload['email']) ??
    normalizeString(sourcePayload['label'])
  );
}

/**
 * Clone the raw observation payload before persisting it on the session.
 * @param payload - Observation payload
 * @returns Deep-cloned payload record
 */
function cloneRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(payload);
}

/**
 * Narrow an unknown value to a plain record.
 * @param value - Arbitrary unknown value
 * @returns Record value when the input is a non-array object
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Normalize a non-empty string field from a loosely typed payload.
 * @param value - Arbitrary payload field
 * @returns Trimmed string when present and non-empty
 */
function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Persist the latest client account linkage onto the resolved session.
 * @param bus - Bus instance used for storage updates
 * @param sessionId - Session being updated
 * @param observation - Raw observation persisted on the session
 * @param clientAccountId - Canonical client account resolved from the observation
 * @returns Whether the canonical client-account linkage changed during the authoritative storage write
 */
async function persistClientAccountObservation(
  bus: IMakaioBus,
  sessionId: string,
  observation: ClientIdentityObservation,
  clientAccountId: string,
): Promise<boolean> {
  // TODO: If session/client account unlink or reset is added later, model it as a
  // separate subject. `client.session.account.observe` only records positive v1
  // observations, so overloading this write path with "clear linkage" semantics
  // would blur "no canonical account resolved" and "explicit unlink requested".
  const updateResult = await bus.request(SessionStorageSubjects.update, {
    sessionId,
    clientId: observation.clientId,
    clientAccountId,
    lastClientIdentityObservation: observation,
  });

  if (!updateResult.success) {
    throw new Error(`Failed to update session "${sessionId}" with client account linkage`);
  }

  return updateResult.clientAccountChanged ?? false;
}
