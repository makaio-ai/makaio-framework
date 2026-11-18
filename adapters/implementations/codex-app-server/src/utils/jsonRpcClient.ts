import { createJsonRpcClient as createGenericClient } from '@makaio/subprocess';
import type { IJsonlTransport } from '@makaio/subprocess';
import type { ServerRequest } from '../protocol/generated/index.js';
import type { StdioTransport } from './createStdioTransport.js';

/**
 * Handler for server requests (e.g., approval requests)
 * @param request - Server request with method and params
 * @returns Response to send back to server
 */
export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;

/**
 * Handler for server notifications
 * @param method - Notification method name
 * @param params - Notification params
 */
export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * JSON-RPC 2.0 client for communicating with codex app-server
 */
export interface JsonRpcClient {
  /**
   * Send a JSON-RPC request and wait for response
   * @param method - Method name to call
   * @param params - Method parameters
   * @returns Promise resolving to response result
   * @throws Error if request fails or times out
   */
  request<T>(method: string, params: unknown): Promise<T>;

  /**
   * Send a JSON-RPC notification (no response expected)
   * @param method - Notification method name
   * @param params - Notification parameters
   */
  notification(method: string, params: unknown): void;

  /**
   * Register a handler for specific notification type
   * @param method - Notification method name to handle
   * @param handler - Function to handle notifications
   */
  onNotification(method: string, handler: NotificationHandler): void;

  /**
   * Register a handler for server requests (approvals)
   * @param handler - Function to handle server requests
   */
  onServerRequest(handler: ServerRequestHandler): void;

  /**
   * Close the client and cleanup resources
   */
  close(): void;
}

// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines-per-function: ["error", { "max": 200 }] */
/**
 * Creates a JSON-RPC 2.0 client wrapping a stdio transport
 * @param transport - Stdio transport for sending/receiving messages
 * @param onTransportFailure - Owner callback for a transport failure. It runs
 *   after the client has rejected its in-flight requests with that failure, and
 *   its subscription ends with the client, so a transport reused by a later
 *   client never notifies an earlier client's owner.
 * @returns JSON-RPC client interface
 * @example
 * ```ts
 * const transport = createStdioTransport(cwd, env);
 * const client = createJsonRpcClient(transport);
 *
 * // Send request
 * const result = await client.request('thread/start', { ... });
 *
 * // Send notification
 * client.notification('initialized', {});
 *
 * // Handle notifications
 * client.onNotification('turn/started', (method, params) => {
 *   console.log('Turn started:', params);
 * });
 *
 * // Handle server requests (approvals)
 * client.onServerRequest(async (request) => {
 *   return { decision: 'accept' };
 * });
 * ```
 */
export function createJsonRpcClient(
  transport: StdioTransport,
  onTransportFailure?: (error: Error) => void,
): JsonRpcClient {
  // Bridge: present StdioTransport as IJsonlTransport for the generic client.
  // Both are multi-subscriber, and the generic client removes its own
  // subscriptions when it closes.
  const bridgedTransport: IJsonlTransport = {
    send: (msg) => transport.send(msg),
    close: () => transport.close(),
    onMessage: (listener) => transport.onMessage(listener),
    onError: (listener) => transport.onError(listener),
    get process() {
      return undefined as never;
    },
  };

  const generic = createGenericClient(bridgedTransport);
  // Subscribed after the generic client, which settles its in-flight requests
  // with the failure before the owner reacts to it.
  // The generic client shuts itself down on a failure without going through
  // `close()` below, so the subscription also ends itself on its first failure.
  const unsubscribeTransportFailure = onTransportFailure
    ? transport.onError((error) => {
        unsubscribeTransportFailure?.();
        onTransportFailure(error);
      })
    : undefined;
  let serverRequestUnsubscribe: (() => void) | undefined;

  return {
    /**
     * Send a JSON-RPC request and wait for response
     * @param method - Method name to call
     * @param params - Method parameters
     * @returns Promise resolving to response result
     */
    request<T>(method: string, params: unknown): Promise<T> {
      return generic.request<T>(method, params);
    },

    /**
     * Send a JSON-RPC notification (no response expected)
     * @param method - Notification method name
     * @param params - Notification parameters
     */
    notification(method: string, params: unknown): void {
      generic.notification(method, params);
    },

    /**
     * Register a handler for specific notification type
     * @param method - Notification method name to handle
     * @param handler - Function to handle notifications
     */
    onNotification(method: string, handler: NotificationHandler): void {
      generic.onNotification(method, handler);
    },

    /**
     * Register a handler for server requests (approvals)
     * @param handler - Function to handle server requests
     */
    onServerRequest(handler: ServerRequestHandler): void {
      serverRequestUnsubscribe?.();
      serverRequestUnsubscribe = generic.onServerRequest((req) => handler(req as ServerRequest));
    },

    /**
     * Close the client and cleanup resources
     */
    close(): void {
      unsubscribeTransportFailure?.();
      serverRequestUnsubscribe?.();
      serverRequestUnsubscribe = undefined;
      generic.close();
    },
  };
}
