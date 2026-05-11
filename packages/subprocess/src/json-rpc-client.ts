import type { IJsonlTransport } from './types.js';

/** Default request timeout for JSON-RPC calls. */
const DEFAULT_JSON_RPC_REQUEST_TIMEOUT_MS = 60_000;

/** JSON-RPC 2.0 request identifier — number or string, must be unique per session. */
type RequestId = number | string;

/** JSON-RPC 2.0 request message sent to the remote. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 notification message (no response expected). */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** Pending request callbacks and timeout state. */
interface PendingJsonRpcRequest {
  /** Resolve function for the pending request. */
  resolve: (value: unknown) => void;
  /** Reject function for the pending request. */
  reject: (error: Error) => void;
  /** Timeout handle, or `null` when timeout is disabled. */
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * Handler for server-initiated requests.
 * @param request - Raw server request object (JSON-RPC 2.0 with `id` and `method`).
 * @returns Promise resolving to the response result to send back.
 */
export type ServerRequestHandler = (request: unknown) => Promise<unknown>;

/**
 * Handler for server-pushed notifications (no `id`, has `method`).
 * @param method - Notification method name.
 * @param params - Notification params.
 */
export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Generic JSON-RPC 2.0 client that wraps an {@link IJsonlTransport}.
 */
export interface IJsonRpcClient {
  /**
   * Send a JSON-RPC 2.0 request and wait for the correlated response.
   * @param method - Method name to call.
   * @param params - Method parameters.
   * @param timeoutMs - Request timeout in milliseconds. Defaults to 60000; use
   *   `0` to disable the automatic timeout.
   * @returns Promise resolving to the typed response result.
   */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;

  /**
   * Send a fire-and-forget notification (no `id`, no response expected).
   * @param method - Notification method name.
   * @param params - Notification parameters.
   */
  notification(method: string, params: unknown): void;

  /**
   * Register a handler for a specific notification method.
   * @param method - Notification method name to match.
   * @param handler - Function called when matching notification arrives.
   * @returns Unsubscribe function that removes the handler.
   */
  onNotification(method: string, handler: NotificationHandler): () => void;

  /**
   * Register a handler for server-initiated requests (requests where the remote
   * holds an `id` and expects a response). Multiple handlers may be registered;
   * every handler receives each request. The response is the first successful
   * handler in registration order; an error is returned only when every handler
   * rejects or throws.
   * @param handler - Function called for each server request. Its resolved value
   *   is sent back as the JSON-RPC result if no earlier registered handler succeeds.
   * @returns Unsubscribe function that removes the handler.
   */
  onServerRequest(handler: ServerRequestHandler): () => void;

  /**
   * Close the client: rejects all pending requests and closes the transport.
   */
  close(): void;
}

/**
 * Create a JSON-RPC 2.0 client on top of a JSONL transport.
 *
 * Message dispatch rules (JSON-RPC 2.0):
 * - `id` + `result`  → correlated response (resolves pending promise)
 * - `id` + `error`   → correlated error response (rejects pending promise)
 * - `id` + `method`  → server-initiated request (call handlers, send response)
 * - `method`, no `id` → notification (call method-specific handler)
 * @param transport - JSONL transport to send/receive messages on.
 * @returns JSON-RPC 2.0 client interface.
 */
// eslint-disable-next-line max-lines-per-function
export function createJsonRpcClient(transport: IJsonlTransport): IJsonRpcClient {
  let nextId = 1;
  let closed = false;

  const pendingRequests = new Map<RequestId, PendingJsonRpcRequest>();
  const notificationHandlers = new Map<string, Set<NotificationHandler>>();
  const serverRequestHandlers = new Set<ServerRequestHandler>();

  /**
   * Generate a unique, monotonically increasing request ID.
   * @returns Next available request ID.
   */
  function generateRequestId(): RequestId {
    return nextId++;
  }

  /**
   * Reject all pending requests with the given error and clear the map.
   * @param error - Error to reject all pending requests with.
   */
  function rejectAllPending(error: Error): void {
    for (const [, pending] of pendingRequests) {
      if (pending.timeoutId !== null) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(error);
    }
    pendingRequests.clear();
  }

  /**
   * Resolve or reject a pending request exactly once and clear its timer.
   * @param id - Request ID to settle.
   * @param settle - Callback receiving the pending request callbacks.
   */
  function settlePending(id: RequestId, settle: (pending: PendingJsonRpcRequest) => void): void {
    const pending = pendingRequests.get(id);
    if (!pending) {
      return;
    }

    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
    }
    pendingRequests.delete(id);
    settle(pending);
  }

  /**
   * Dispatch an incoming message according to JSON-RPC 2.0 semantics.
   * @param message - Raw parsed message from the transport.
   */
  function handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;

    const msg = message as Record<string, unknown>;
    const id = 'id' in msg ? (msg['id'] as RequestId) : undefined;

    // Correlated response (success)
    if (id !== undefined && 'result' in msg && !('method' in msg)) {
      settlePending(id, (pending) => {
        pending.resolve(msg['result']);
      });
      return;
    }

    // Correlated response (error)
    if (id !== undefined && 'error' in msg && !('method' in msg)) {
      settlePending(id, (pending) => {
        const rpcError = msg['error'] as { code: number; message: string };
        pending.reject(new Error(`JSON-RPC error ${rpcError.code}: ${rpcError.message}`));
      });
      return;
    }

    // Server-initiated request (has both `id` and `method`)
    if (id !== undefined && 'method' in msg) {
      void handleServerRequest(message, id, msg['method'] as string);
      return;
    }

    // Notification (has `method`, no `id`)
    if ('method' in msg && !('id' in msg)) {
      const method = msg['method'] as string;
      const handlers = notificationHandlers.get(method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(method, msg['params']);
          } catch {
            // Notification subscribers are independent; one faulty handler
            // must not prevent later subscribers from observing the message.
          }
        }
      }
      return;
    }
  }

  /**
   * Dispatch a server-initiated request to registered handlers.
   * @param message - Raw JSON-RPC request message.
   * @param requestId - JSON-RPC request ID to echo in the response.
   * @param method - JSON-RPC method name.
   */
  async function handleServerRequest(message: unknown, requestId: RequestId, method: string): Promise<void> {
    const handlers = [...serverRequestHandlers];
    if (handlers.length === 0) {
      transport.send({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32601, message: `No handler registered for server request: ${method}` },
      });
      return;
    }

    // Invoke every handler, but choose the response deterministically by
    // registration order. Rejections are reported only if no handler succeeds.
    const results = await Promise.allSettled(handlers.map((handler) => Promise.resolve().then(() => handler(message))));
    if (closed) return;

    const success = results.find((result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled');
    if (success) {
      transport.send({ jsonrpc: '2.0', id: requestId, result: success.value });
      return;
    }

    const firstFailure = results[0] as PromiseRejectedResult | undefined;
    const reason = firstFailure?.reason;
    const messageText = reason instanceof Error ? reason.message : String(reason ?? 'handler failed');
    transport.send({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: messageText },
    });
  }

  const unsubMessage = transport.onMessage(handleMessage);

  const unsubError = transport.onError((error) => {
    rejectAllPending(error);
  });

  return {
    request<T>(method: string, params: unknown, timeoutMs: number = DEFAULT_JSON_RPC_REQUEST_TIMEOUT_MS): Promise<T> {
      if (closed) {
        return Promise.reject(new Error('JSON-RPC client is closed'));
      }
      return new Promise<T>((resolve, reject) => {
        const id = generateRequestId();
        const requestMessage: JsonRpcRequest = {
          jsonrpc: '2.0',
          id,
          method,
          params,
        };
        const timeoutId =
          timeoutMs === 0
            ? null
            : setTimeout(() => {
                settlePending(id, (pending) => {
                  pending.reject(new Error(`JSON-RPC request timed out after ${timeoutMs}ms: ${method}`));
                });
              }, timeoutMs);
        pendingRequests.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeoutId,
        });
        try {
          transport.send(requestMessage);
        } catch (error) {
          settlePending(id, (pending) => {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          });
        }
      });
    },

    notification(method: string, params: unknown): void {
      if (closed) return;
      const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
      transport.send(msg);
    },

    onNotification(method: string, handler: NotificationHandler): () => void {
      let handlers = notificationHandlers.get(method);
      if (!handlers) {
        handlers = new Set();
        notificationHandlers.set(method, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          notificationHandlers.delete(method);
        }
      };
    },

    onServerRequest(handler: ServerRequestHandler): () => void {
      serverRequestHandlers.add(handler);
      return () => {
        serverRequestHandlers.delete(handler);
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      unsubMessage();
      unsubError();
      rejectAllPending(new Error('JSON-RPC client closed'));
      notificationHandlers.clear();
      serverRequestHandlers.clear();
      transport.close();
    },
  };
}
