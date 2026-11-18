import { describeTransportEnd } from './process-end.js';
import type { JsonlChannel } from './types.js';

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
 * Convert the `error` member of a JSON-RPC error response into an `Error`.
 *
 * The member comes from the remote process, so its shape is checked rather
 * than assumed; a response without a well-formed error object still rejects
 * its request instead of throwing inside message dispatch.
 * @param value - The `error` member of the response.
 * @returns Error describing the remote failure.
 */
function toRpcError(value: unknown): Error {
  if (typeof value !== 'object' || value === null) {
    return new Error('JSON-RPC error response without an error object');
  }
  const { code, message } = value as Record<string, unknown>;
  const codeText = typeof code === 'number' ? String(code) : 'unknown';
  const messageText = typeof message === 'string' ? message : 'no message';
  return new Error(`JSON-RPC error ${codeText}: ${messageText}`);
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
 * Generic JSON-RPC 2.0 client that wraps a {@link JsonlChannel}.
 *
 * Every request settles exactly once. The client ends either through its own
 * {@link IJsonRpcClient.close} (pending requests reject at once with a closed
 * error) or through the channel's end report, whatever its cause: an unexpected
 * end and a stop someone else requested on the channel both reject the pending
 * requests with a description of that end, after the channel delivered its last
 * message. Either way later requests reject immediately, and a request issued
 * while the channel no longer accepts writes rejects with the write failure.
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
   * Send a fire-and-forget notification (no `id`, no response expected). A
   * no-op once the client is closed; throws when the channel no longer accepts
   * writes while the client is still open.
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
   * Close the client: rejects all pending requests at once and closes the
   * channel, unless the channel already ended. Idempotent.
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
 * @param transport - JSONL channel to send/receive messages on.
 * @returns JSON-RPC 2.0 client interface.
 */
// eslint-disable-next-line max-lines-per-function
export function createJsonRpcClient(transport: JsonlChannel): IJsonRpcClient {
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
        pending.reject(toRpcError(msg['error']));
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
      // Dispatch over a snapshot, with the contract of `notifyListeners` that
      // every other listener path of this package follows: each handler
      // registered when the message arrived receives it, whatever an earlier
      // handler subscribes, unsubscribes or closes. The message was received
      // before any of that, so hiding it from the remaining handlers would make
      // their view depend on handler order.
      for (const handler of [...(notificationHandlers.get(method) ?? [])]) {
        try {
          handler(method, msg['params']);
        } catch {
          // Notification subscribers are independent; one faulty handler
          // must not prevent later subscribers from observing the message.
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
      respond({
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
      respond({ jsonrpc: '2.0', id: requestId, result: success.value });
      return;
    }

    const firstFailure = results[0] as PromiseRejectedResult | undefined;
    const reason = firstFailure?.reason;
    const messageText = reason instanceof Error ? reason.message : String(reason ?? 'handler failed');
    respond({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: messageText },
    });
  }

  /**
   * Write the response to a server request. A server request can still arrive
   * while the channel is ending (its last messages are delivered after writing
   * was blocked); the end reaches this client separately, so a response that
   * can no longer be written is dropped instead of escaping the dispatch.
   * @param response - JSON-RPC response message.
   */
  function respond(response: object): void {
    try {
      transport.send(response);
    } catch {
      // The channel no longer accepts writes; its end is reported on its own.
    }
  }

  const unsubMessage = transport.onMessage(handleMessage);

  // The end report arrives once, for every cause, after the channel delivered
  // its last message: a response written just before the end has settled its
  // request by now, and nothing outstanding can be answered anymore. A stop the
  // channel's owner requested settles the pending requests too, so none hangs.
  void transport.ended.then((end) => {
    shutdown(new Error(`JSON-RPC transport ${describeTransportEnd(end)}`));
  });

  /**
   * Move the client into its terminal closed state: detach from the channel and
   * reject every pending request. Later requests are rejected immediately
   * instead of being written to a channel that is gone.
   * @param reason - Error passed to every pending request.
   * @returns Whether this call closed the client; `false` when it was already closed.
   */
  function shutdown(reason: Error): boolean {
    if (closed) return false;
    closed = true;
    unsubMessage();
    rejectAllPending(reason);
    notificationHandlers.clear();
    serverRequestHandlers.clear();
    return true;
  }

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
      // The channel's close is bounded and its result never rejects; the end
      // it leads to finds this client closed already.
      if (shutdown(new Error('JSON-RPC client closed'))) void transport.close();
    },
  };
}
