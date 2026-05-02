/**
 * makaio/bus-server
 *
 * Framework-agnostic WebSocket bus server library.
 *
 * This library provides a clean, portable wrapper around the WebSocket
 * transport for server-side usage. It handles transport orchestration
 * and MakaioBus integration without any adapter-specific logic.
 *
 * ## Features
 * - Framework-agnostic (works with any WebSocket server)
 * - Adapter-agnostic (pure transport layer)
 * - Clean lifecycle management (start/stop)
 * - Optional authentication
 * - Connection tracking
 *
 * ## Usage
 *
 * ### Basic Usage
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
 * ```
 *
 * ### With Vite
 * ```typescript
 * // vite.config.ts
 * import { ViteBusServerPlugin } from '@makaio/bus-server-vite';
 *
 * export default defineConfig({
 *   extensions: [
 *     ViteBusServerPlugin({
 *       debug: true,
 *     }),
 *   ],
 * });
 * ```
 */

export { createBusServer } from './server.js';
export { LoopbackTransport } from './loopback-transport.js';
export type { LoopbackTransportOptions } from './loopback-transport.js';
export type { BusServer, BusServerConfig } from './types.js';

/**
 * Re-export commonly used types from dependencies for convenience.
 */
export type { TransportAuth, WebSocketServerLike } from '@makaio/bus-transport-websocket';

/**
 * Re-export server lifecycle utilities for convenience.
 */
export { startBusServer } from './server-lifecycle.js';
export type { StartBusServerOptions } from './server-lifecycle.js';

/**
 * Hono WebSocket bridge — feeds Hono-upgraded sockets into ServerTransport.
 */
export { HonoWebSocketBridge } from './hono-websocket-bridge.js';
