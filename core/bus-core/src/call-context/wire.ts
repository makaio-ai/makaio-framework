import type { CallContext, CrossHostMetadata, Party, PartyRef, TransportReceiveContext } from '@makaio/core';
import {
  CrossHostMetadataSchema,
  MAKAIO_ANONYMOUS_PARTY_KIND,
  MAKAIO_EXTENSION_PARTY_KIND,
  MAKAIO_HOST_PARTY_KIND,
} from '@makaio/core';
import { formatBusDiagnostic } from '../utils/debug-log.js';
import { InvalidCallContextError, mintCallContext } from './mint.js';

/** Identifier used for the anonymous caller when there is neither a connection id nor a receive context. */
const UNKNOWN_CONNECTION_ID = 'unknown';

/** Upper bound of remembered reports; the memory is cleared when it is reached. */
const MAX_REPORTED = 10_000;

/** Whether an attesting connection of each direction may present an in-process principal kind. */
const ACCEPTS_IN_PROCESS_PRINCIPAL = {
  inbound: false,
  outbound: true,
} as const satisfies Record<NonNullable<TransportReceiveContext['attests']>, boolean>;

/**
 * Sink for the warnings of the receive path.
 *
 * Called with one formatted line at warn level. A parameter, not a direct
 * `console` access, so tests can observe it.
 */
export type WireReport = (message: string) => void;

/**
 * Reports already made, per connection and reason. Module-level: one registry per module instance.
 */
const reported = new Set<string>();

/**
 * Report a receive-path problem once per connection and reason.
 * @param report - Warn-level sink
 * @param connection - Transport name and connection id of the receive
 * @param reason - Claimed kind, or a fixed token for another problem
 * @param message - Headline of the report
 */
function reportOnce(
  report: WireReport,
  connection: { readonly transportName: string; readonly connectionId?: string },
  reason: string,
  message: string,
): void {
  const key = JSON.stringify([connection.transportName, connection.connectionId ?? null, reason]);
  if (reported.has(key)) return;
  if (reported.size >= MAX_REPORTED) reported.clear();
  reported.add(key);
  report(
    formatBusDiagnostic(`[MakaioBus] ${message}`, {
      transport: connection.transportName,
      connection: connection.connectionId ?? '(none)',
    }),
  );
}

/**
 * Reset the remembered reports between test runs.
 * @internal
 * @returns Reset function in test mode, undefined otherwise
 */
export const __resetWireReports =
  process.env.NODE_ENV === 'test'
    ? () => {
        reported.clear();
      }
    : undefined;

/**
 * Metadata that travels with a message to another host.
 *
 * Carries the principal as kind and id only, never `claims`. Omitted when the
 * principal is the party of the sending host itself: the receiver then sets
 * the verified caller as principal.
 * @param call - The call context of the message that is sent.
 * @param ownHost - The host party of the sending process.
 * @returns The metadata, or `undefined` when there is nothing to carry.
 */
export function wireMetadataOf(call: CallContext, ownHost: PartyRef): CrossHostMetadata | undefined {
  const { principal } = call;
  if (principal.kind === ownHost.kind && principal.id === ownHost.id) return undefined;
  return { principal: { kind: principal.kind, id: principal.id } };
}

/**
 * Whether a kind can only come into being inside the process.
 * @param kind - Kind a receive path claims for the caller.
 * @returns `true` for `makaio.extension` and `makaio.host`.
 */
function isInProcessOnlyKind(kind: string): boolean {
  return kind === MAKAIO_EXTENSION_PARTY_KIND || kind === MAKAIO_HOST_PARTY_KIND;
}

/**
 * Check whether the connection is trusted to present this principal.
 * @param principal - Validated principal reference from the wire.
 * @param connection - Local receive context or diagnostic fallback.
 * @param report - Warn-level sink for rejected claims.
 * @returns The principal when the connection may attest it, or undefined.
 */
function acceptPrincipal(
  principal: PartyRef | undefined,
  connection: TransportReceiveContext,
  report: WireReport,
): PartyRef | undefined {
  if (principal === undefined) return undefined;
  const { attests } = connection;
  if (attests !== undefined && (ACCEPTS_IN_PROCESS_PRINCIPAL[attests] || !isInProcessOnlyKind(principal.kind))) {
    return principal;
  }
  const reason = attests === undefined ? 'unattested-principal' : 'in-process-principal';
  reportOnce(report, connection, reason, `Dropped wire principal claim (${reason}).`);
  return undefined;
}

/**
 * Derive the call context of a received message.
 *
 * The caller is `receive.caller`, else the transport's `declared` caller, else
 * the anonymous caller (id: connection id, else transport name). A caller of a
 * kind that only exists in the process (`makaio.extension`, `makaio.host`) is
 * not accepted from a receive path: the caller becomes anonymous, the message
 * is still delivered, and `report` gets one warning per connection and claimed
 * kind. Invalid callers are also downgraded and reported once per connection.
 * A downgraded call is anonymous throughout: caller and principal are the
 * anonymous party and nothing is attested, even when the metadata carried an
 * acceptable claim.
 * A valid `metadata.principal` is accepted only from an attesting connection.
 * Outbound connections may also attest in-process kinds. For an accepted
 * claim `attestedBy` is the caller. Otherwise the principal is the caller.
 * Invalid `metadata` is dropped and reported once per connection. Nothing is
 * ever read from the payload.
 *
 * An attesting connection such as a job run may claim any principal that is
 * not of an in-process kind. Nothing on this host yet narrows that claim by the
 * rights of the attesting party; `attestedBy` only records who vouched. A host
 * that relays the message stamps the principal it accepted and vouches for it
 * itself; the first attesting party does not cross the host boundary.
 * @param receive - Receive context of the transport; `undefined` when the message did not come over a transport.
 * @param declared - Caller the transport declares (`BusTransport.declaredCaller`).
 * @param metadata - Wire metadata of the message, unchecked.
 * @param report - Warn-level sink for downgrades and dropped metadata.
 * @returns A freshly minted call context.
 */
export function callFromReceive(
  receive: TransportReceiveContext | undefined,
  declared: Party | undefined,
  metadata: unknown,
  report: WireReport,
): CallContext {
  const connection = {
    transportName: receive?.transportName ?? UNKNOWN_CONNECTION_ID,
    ...(receive?.connectionId === undefined ? {} : { connectionId: receive.connectionId }),
  };
  const anonymous: Party = {
    kind: MAKAIO_ANONYMOUS_PARTY_KIND,
    id: connection.connectionId || connection.transportName || UNKNOWN_CONNECTION_ID,
  };

  const parsed = metadata === undefined ? undefined : CrossHostMetadataSchema.safeParse(metadata);
  if (parsed?.success === false) {
    reportOnce(report, connection, 'metadata', 'Dropped invalid wire metadata of a received message.');
  }
  const principal = acceptPrincipal(parsed?.success ? parsed.data.principal : undefined, receive ?? connection, report);

  const mintForCaller = (caller: Party): CallContext =>
    mintCallContext({
      caller,
      principal: principal ?? caller,
      ...(principal === undefined ? {} : { attestedBy: caller }),
    });

  // A downgraded caller loses any accepted claim: nobody trusted vouches for it.
  const mintAnonymous = (): CallContext => mintCallContext({ caller: anonymous, principal: anonymous });

  let call: CallContext;
  try {
    call = mintForCaller(receive?.caller ?? declared ?? anonymous);
  } catch (error) {
    if (!(error instanceof InvalidCallContextError)) throw error;
    reportOnce(report, connection, 'invalid-caller', 'Receive path delivered an invalid caller; treated as anonymous.');
    return mintAnonymous();
  }

  const { caller } = call;
  if (isInProcessOnlyKind(caller.kind)) {
    reportOnce(
      report,
      connection,
      caller.kind,
      `Receive path delivered a caller of kind '${caller.kind}', which exists only in the process; ` +
        `treated as '${MAKAIO_ANONYMOUS_PARTY_KIND}'.`,
    );
    return mintAnonymous();
  }

  return call;
}
