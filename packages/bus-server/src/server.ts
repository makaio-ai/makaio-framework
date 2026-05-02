/**
 * Bus server implementation.
 *
 * Provides a clean wrapper around the WebSocket server transport with
 * lifecycle management and MakaioBus integration.
 */

import { MakaioBus, type IMakaioBus, type BusTransport, type TransportRegistration } from '@makaio/bus-core';
import { ServerTransport } from '@makaio/bus-transport-websocket';
import type { BusServer, BusServerConfig } from './types.js';
import { LoopbackTransport } from './loopback-transport.js';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { normalizeLoopbackName } from './loopback-name.js';

const PRIMARY_TRANSPORT = 'websocket';
type Unsubscribe = () => void;

interface BusServerRuntimeState {
  unregister: TransportRegistration | null;
  unregisterLoopback: TransportRegistration | null;
  debugUnsubscribers: Unsubscribe[];
  isStarted: boolean;
}

/**
 * Register debug event log listeners for top-level adapter/agent/session namespaces.
 * @param bus - Bus instance used to register debug subscriptions
 * @returns Unsubscribe callbacks for all debug listeners
 */
function registerDebugBusLogging(bus: IMakaioBus): Unsubscribe[] {
  const unsubAdapter = bus.on(AdapterSubjects.$all, (context) => {
    console.info(`Adapter Event`, JSON.stringify(context));
  });
  const unsubAgent = bus.on(AgentSubjects.$all, (context) => {
    console.info(`Agent Event`, JSON.stringify(context));
  });
  const unsubSession = bus.on(SessionSubjects.$all, (context) => {
    console.info(`Session Event`, JSON.stringify(context));
  });
  return [unsubAdapter, unsubAgent, unsubSession];
}

/**
 * Remove and clear all debug bus listeners.
 * @param debugUnsubscribers - Active debug listener unsubscribers
 * @param context - Log context suffix for cleanup failure messages
 */
function clearDebugBusLogging(debugUnsubscribers: Unsubscribe[], context: string): void {
  for (const unsubscribe of debugUnsubscribers) {
    try {
      unsubscribe();
    } catch (unsubscribeError) {
      console.error(`[BusServer] Failed to remove debug bus listener ${context}`, unsubscribeError);
    }
  }
  debugUnsubscribers.length = 0;
}

/**
 * Cleanup partially-initialized start state while preserving the original startup error.
 * @param state - Runtime mutable state for this server instance
 * @param transportConnected - Whether the primary transport connected successfully
 * @param transport - Primary websocket transport
 */
async function cleanupFailedStart(
  state: BusServerRuntimeState,
  transportConnected: boolean,
  transport: BusTransport,
): Promise<void> {
  if (state.unregisterLoopback) {
    try {
      state.unregisterLoopback.unregister();
    } catch (unregisterLoopbackError) {
      console.error('[BusServer] Failed to unregister loopback transport after startup error', unregisterLoopbackError);
    }
    state.unregisterLoopback = null;
  }
  if (transportConnected) {
    await transport.disconnect().catch((disconnectError) => {
      console.error('[BusServer] Failed to disconnect transport after startup error', disconnectError);
    });
  }
  if (state.unregister) {
    try {
      state.unregister.unregister();
    } catch (unregisterError) {
      console.error('[BusServer] Failed to unregister primary transport after startup error', unregisterError);
    }
    state.unregister = null;
  }
  clearDebugBusLogging(state.debugUnsubscribers, 'after startup error');
}

/**
 * Start and register primary/loopback transports for this server instance.
 * @param bus - Bus instance used for transport registration
 * @param transport - Primary websocket transport
 * @param normalizedLoopbackName - Optional normalized loopback transport name
 * @param debug - Whether debug logging is enabled
 * @param state - Mutable runtime state for this server instance
 */
async function startServerTransport(
  bus: IMakaioBus,
  transport: BusTransport,
  normalizedLoopbackName: string | undefined,
  debug: boolean,
  state: BusServerRuntimeState,
): Promise<void> {
  const { transportRegistry } = bus.getContext();
  let transportConnected = false;

  try {
    if (debug && state.debugUnsubscribers.length === 0) {
      state.debugUnsubscribers.push(...registerDebugBusLogging(bus));
    }
    state.unregister = transportRegistry.registerTransport(PRIMARY_TRANSPORT, transport);
    await transport.connect();
    transportConnected = true;

    if (normalizedLoopbackName) {
      const loopback = new LoopbackTransport({ target: transport, name: normalizedLoopbackName });
      state.unregisterLoopback = transportRegistry.registerTransport(normalizedLoopbackName, loopback);
    }
  } catch (error) {
    await cleanupFailedStart(state, transportConnected, transport);
    throw error;
  }
}

/**
 * Stop and unregister all transports for this server instance.
 * @param transport - Primary websocket transport
 * @param state - Mutable runtime state for this server instance
 */
async function stopServerTransport(transport: BusTransport, state: BusServerRuntimeState): Promise<void> {
  if (state.unregisterLoopback) {
    state.unregisterLoopback.unregister();
    state.unregisterLoopback = null;
  }
  if (state.unregister) {
    state.unregister.unregister();
    state.unregister = null;
  }
  clearDebugBusLogging(state.debugUnsubscribers, 'during stop');
  await transport.disconnect();
}

/**
 * Create a bus server instance.
 *
 * This function creates a WebSocket server transport and provides a clean
 * API for lifecycle management. The server will:
 * - Accept incoming client connections
 * - Handle optional authentication
 * - Broadcast messages to all connected clients
 * - Integrate with MakaioBus for message routing
 * @param config - Server configuration
 * @returns BusServer instance with start/stop methods
 * @example
 * ```typescript
 * import { WebSocketServer } from 'ws';
 * import { createBusServer } from '@makaio/bus-server';
 * import { HmacAuth } from '@makaio/bus-transport-websocket';
 *
 * const wss = new WebSocketServer({ port: 8080 });
 * const server = createBusServer({
 *   websocket: wss,
 *   auth: new HmacAuth({ secret: process.env.BUS_SECRET! }),
 *   debug: true,
 * });
 *
 * await server.start();
 * console.debug('Bus server started');
 * console.debug('Connected clients:', server.getConnectionCount());
 *
 * // Later...
 * await server.stop();
 * ```
 */
export function createBusServer(config: BusServerConfig): BusServer {
  const { websocket, auth, debug = false, bus: providedBus, loopbackName } = config;
  const bus: IMakaioBus = providedBus ?? MakaioBus;
  const normalizedLoopbackName = normalizeLoopbackName(loopbackName);

  // Create the server transport
  const transport = new ServerTransport({
    websocket,
    auth,
    debug,
  });

  const state: BusServerRuntimeState = {
    unregister: null,
    unregisterLoopback: null,
    debugUnsubscribers: [],
    isStarted: false,
  };

  return {
    transport,

    async start(): Promise<void> {
      if (state.isStarted) {
        throw new Error('BusServer is already started');
      }

      await startServerTransport(bus, transport, normalizedLoopbackName, debug, state);
      state.isStarted = true;

      if (debug) {
        console.info('[BusServer] Started and registered transport');
      }
    },

    async stop(): Promise<void> {
      if (!state.isStarted) {
        if (debug) {
          console.warn('[BusServer] stop() called when not started');
        }
        return;
      }

      await stopServerTransport(transport, state);
      state.isStarted = false;

      if (debug) {
        console.info('[BusServer] Stopped and unregistered transport');
      }
    },

    getConnectionCount(): number {
      return transport.getConnectionCount();
    },
  };
}
