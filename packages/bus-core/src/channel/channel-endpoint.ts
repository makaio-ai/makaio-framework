import type { IDirectChannel, ChannelEndpoint, ChannelEndpointOptions } from './types.js';
import type { MakaioBusContext } from '../types/bus.js';
import type { RequestMessagePayload, SubjectDefinition } from '@makaio/core';
import type { BusTransportKeys } from '../registries/transport-registry.js';
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey } from './crypto.js';
import { ChannelAuthError } from '../errors/channel-auth-error.js';
import { SystemChannelSchemas, type ChannelOpenRequest, type ChannelOpenResponse } from './system-namespace.js';
import { DirectChannel } from './direct-channel.js';
import { on as internalOn } from '../methods/on.js';
import { request as internalRequest } from '../methods/request.js';

/**
 * The domain under which the system channel subjects are registered.
 * Kept internal — callers interact only through `createChannelEndpoint` / `openChannel`.
 */
const SYSTEM_NAMESPACE = 'system';

/**
 * Concrete type for the `system.channel.open` SubjectDefinition.
 *
 * This mirrors what `registerNamespace('system', SystemChannelSchemas).subjects.channel.open`
 * returns, without importing the global `MakaioBus` singleton (which would introduce
 * a circular module dependency through the barrel export).
 */
type ChannelOpenSubjectDef = SubjectDefinition<
  { 'channel.open': RequestMessagePayload<ChannelOpenRequest, ChannelOpenResponse> },
  'channel.open',
  'system'
>;

/**
 * Ensure the `system` namespace is registered on the given bus context and
 * return the typed `channel.open` subject definition.
 *
 * Idempotent: `registerNamespace` returns the already-registered namespace on
 * repeated calls, so this is always safe to call at the top of every entry point.
 * @param context - Bus context to register the namespace on
 * @returns The `channel.open` SubjectDefinition
 */
function ensureSystemNamespace(context: MakaioBusContext): ChannelOpenSubjectDef {
  const ns = context.namespaceRegistry.registerNamespace(SYSTEM_NAMESPACE, SystemChannelSchemas);
  // subjects are nested: 'channel.open' schema key → subjects.channel.open
  return (ns.subjects as { channel: { open: ChannelOpenSubjectDef } }).channel.open;
}

/**
 * Register a channel endpoint that accepts encrypted point-to-point connections.
 *
 * Listens for `system.channel.open` requests. When a request arrives for this
 * endpoint name with the correct token:
 * 1. Performs the ECDH key exchange (generates a keypair, derives the shared secret).
 * 2. Instantiates an {@link IDirectChannel} for the endpoint side.
 * 3. Calls `callback` so the endpoint can register its channel-scoped handlers.
 * 4. Returns the channel ID and the endpoint public key to the client.
 *
 * Multiple endpoints can coexist on the same bus context; each handles only
 * requests whose `payload.endpoint` matches its own name.
 * @param context - Bus context to register the endpoint handler on
 * @param endpointName - Logical name for this endpoint (e.g., 'credentials')
 * @param callback - Called with the new {@link IDirectChannel} once the handshake
 *   is complete; use this to register channel handlers before the client receives
 *   the handshake response
 * @param options - Endpoint options including the shared capability token
 * @returns A {@link ChannelEndpoint} handle whose `close()` unregisters the endpoint
 */
export function createChannelEndpoint(
  context: MakaioBusContext,
  endpointName: string,
  callback: (channel: IDirectChannel) => void,
  options: ChannelEndpointOptions,
): ChannelEndpoint {
  const channelOpenSubject = ensureSystemNamespace(context);

  const unsub = internalOn(context, channelOpenSubject, async (ctx) => {
    // Let other registered endpoints handle requests not addressed to us.
    if (ctx.payload.endpoint !== endpointName) {
      await ctx.next();
      return;
    }

    if (ctx.payload.token !== options.token) {
      throw new ChannelAuthError(endpointName);
    }

    // ECDH key exchange.
    const { publicKey, privateKey } = await generateKeyPair();
    const clientKey = await importPublicKey(ctx.payload.clientPubKey);
    const sharedKey = await deriveSharedKey(privateKey, clientKey);
    const channelId = globalThis.crypto.randomUUID();

    // Intersect client-requested transports with registered ones to prevent
    // unknown or stale transport names from reaching the DirectChannel.
    const knownTransports = new Set(context.transportRegistry.names());
    const validTransports = (ctx.payload.transports ?? []).filter((t) => knownTransports.has(t as BusTransportKeys));
    const channel = new DirectChannel(channelId, sharedKey, context, validTransports as BusTransportKeys[]);
    try {
      callback(channel);

      ctx.setResult({
        channelId,
        endpointPubKey: await exportPublicKey(publicKey),
      });
    } catch (error) {
      // Roll back the partially initialized channel so its handlers and key
      // material don't leak when the endpoint callback fails.
      channel.close();
      throw error;
    }
  });

  return {
    name: endpointName,
    token: options.token,
    // Closing the endpoint only prevents new connections — existing DirectChannel
    // instances remain active until their respective peers close them. When the
    // owning service destroys, its cleanup lifecycle handles handler removal.
    // Explicit per-channel tracking is a future seam.
    close: unsub,
  };
}

/**
 * Open an encrypted point-to-point channel to a registered endpoint.
 *
 * Performs the ECDH handshake via `system.channel.open`:
 * 1. Generates an ephemeral ECDH keypair.
 * 2. Sends the client public key and capability token to the endpoint.
 * 3. Receives the channel ID and endpoint public key.
 * 4. Derives the shared AES-256-GCM key from the client private key and endpoint
 *    public key.
 * 5. Returns a `IDirectChannel` ready for encrypted communication.
 *
 * By default the handshake is dispatched over all registered transports so the
 * endpoint can reside in a different process. Pass `transports: []` to restrict
 * the handshake (and the resulting channel) to the local process only — this is
 * the correct choice whenever both sides are guaranteed to share the same bus
 * context (e.g., credential service and its same-process callers).
 * @param context - Bus context to use for the handshake request
 * @param endpointName - Logical name of the endpoint to connect to
 * @param options - Connection options including the shared capability token and
 *   an optional transport allowlist (`transports: []` for local-only)
 * @returns Resolved `IDirectChannel` once the handshake completes
 * @throws \{RequestError\} If the handshake fails — for authentication failures, the
 *   cause is a \{ChannelAuthError\}
 * @throws \{NoHandlerError\} If no endpoint with the given name is registered
 */
export async function openChannel(
  context: MakaioBusContext,
  endpointName: string,
  options: { token: string; transports?: ReadonlyArray<BusTransportKeys> },
): Promise<IDirectChannel> {
  const channelOpenSubject = ensureSystemNamespace(context);

  const { publicKey, privateKey } = await generateKeyPair();
  const clientPubKey = await exportPublicKey(publicKey);

  const hasExplicitTransports = options.transports !== undefined;
  // The non-null assertion is safe: the hasExplicitTransports guard above confirms
  // options.transports is defined when this branch executes.
  const effectiveTransports: BusTransportKeys[] = hasExplicitTransports
    ? [...options.transports!]
    : [...context.transportRegistry.names()];

  // Design choice: the default transport scope is all registered transports,
  // matching the bus's default routing behavior. The relay transport provides
  // its own E2E encryption for cross-network traffic (see docs/relay.md).
  // Callers handling same-process secrets (e.g., credentials) should pass
  // transports: [] explicitly. Making local-only the default would be safer
  // but contradicts the design principle that channels ride existing bus
  // infrastructure for cross-process communication.
  //
  // Only constrain request routing when the caller provided an explicit allowlist.
  // Without it, dispatch uses its default advertised-handler routing — more resilient
  // than probing every registered transport with the capability token.
  const requestOptions = hasExplicitTransports ? { transports: effectiveTransports } : undefined;

  const response = await internalRequest(
    context,
    channelOpenSubject,
    // effectiveTransports is cast to string[] to satisfy the wire schema; the endpoint
    // side casts it back to BusTransportKeys[] after the handshake.
    { endpoint: endpointName, token: options.token, clientPubKey, transports: effectiveTransports as string[] },
    requestOptions,
  );

  const peerKey = await importPublicKey(response.endpointPubKey);
  const sharedKey = await deriveSharedKey(privateKey, peerKey);
  return new DirectChannel(response.channelId, sharedKey, context, effectiveTransports);
}
