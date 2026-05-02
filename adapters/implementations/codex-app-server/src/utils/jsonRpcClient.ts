import type { ServerNotification, ServerRequest } from '../protocol/generated/index.js';
import type { StdioTransport } from './createStdioTransport.js';

/**
 * JSON-RPC 2.0 request identifier (number or string, must be unique)
 */
type RequestId = number | string;

/**
 * JSON-RPC 2.0 request message
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 notification message
 */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

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

// NOTE: do NOT change without explicit human approval
/* eslint max-lines-per-function: ["error", { "max": 200 }] */
/**
 * Creates a JSON-RPC 2.0 client wrapping a stdio transport
 * @param transport - Stdio transport for sending/receiving messages
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
export function createJsonRpcClient(transport: StdioTransport): JsonRpcClient {
  let nextId = 1;
  const pendingRequests = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const notificationHandlers = new Map<string, NotificationHandler>();
  let serverRequestHandler: ServerRequestHandler | null = null;

  /**
   * Generate unique request ID
   * @returns Unique request ID
   */
  function generateRequestId(): RequestId {
    return nextId++;
  }

  /**
   * Handle incoming messages from transport
   */
  transport.onMessage((message) => {
    // Handle response to client request
    if ('id' in message && 'result' in message) {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }

    // Handle response error
    if ('id' in message && 'error' in message) {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        const errorMessage = message.error as { code: number; message: string };
        const error = new Error(`JSON-RPC error ${errorMessage.code}: ${errorMessage.message}`);
        pending.reject(error);
      }
      return;
    }

    // Handle server request (approval)
    if ('id' in message && 'method' in message) {
      const serverRequest = message as ServerRequest;
      if (serverRequestHandler) {
        serverRequestHandler(serverRequest)
          .then((result) => {
            transport.send({
              jsonrpc: '2.0',
              id: serverRequest.id,
              result,
            });
          })
          .catch((error: Error) => {
            console.warn(`[JsonRpcClient] serverRequestHandler error: ${error.message}`);
            transport.send({
              jsonrpc: '2.0',
              id: serverRequest.id,
              error: {
                code: -32603,
                message: error.message,
              },
            });
          });
      }
      return;
    }

    // Handle notification
    if ('method' in message && !('id' in message)) {
      const notification = message as ServerNotification;
      const handler = notificationHandlers.get(notification.method);
      if (handler) {
        handler(notification.method, notification.params);
      }
      return;
    }
  });

  /**
   * Handle errors from transport
   */
  transport.onError((error) => {
    // Reject all pending requests with the error
    for (const [id, pending] of pendingRequests.entries()) {
      pending.reject(error);
      pendingRequests.delete(id);
    }
  });

  return {
    /**
     * Send a JSON-RPC request and wait for response
     * @param method - Method name to call
     * @param params - Method parameters
     * @returns Promise resolving to response result
     */
    request<T>(method: string, params: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = generateRequestId();
        const request: JsonRpcRequest = {
          jsonrpc: '2.0',
          id,
          method,
          params,
        };

        pendingRequests.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        transport.send(request);
      });
    },

    /**
     * Send a JSON-RPC notification (no response expected)
     * @param method - Notification method name
     * @param params - Notification parameters
     */
    notification(method: string, params: unknown): void {
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method,
        params,
      };
      transport.send(notification);
    },

    /**
     * Register a handler for specific notification type
     * @param method - Notification method name to handle
     * @param handler - Function to handle notifications
     */
    onNotification(method: string, handler: NotificationHandler): void {
      notificationHandlers.set(method, handler);
    },

    /**
     * Register a handler for server requests (approvals)
     * @param handler - Function to handle server requests
     */
    onServerRequest(handler: ServerRequestHandler): void {
      serverRequestHandler = handler;
    },

    /**
     * Close the client and cleanup resources
     */
    close(): void {
      // Reject all pending requests
      const error = new Error('JSON-RPC client closed');
      for (const [id, pending] of pendingRequests.entries()) {
        pending.reject(error);
        pendingRequests.delete(id);
      }
      transport.close();
    },
  };
}
