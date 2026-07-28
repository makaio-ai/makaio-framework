/**
 * Fetch-compatible MCP request handler.
 *
 * Provides {@link createFetchMcpHandler}, the Web Standard sibling of
 * `createHttpMcpHandler`.  Uses the MCP SDK's
 * `WebStandardStreamableHTTPServerTransport` so the resulting handler
 * accepts a `Request` and returns a `Promise<Response>`, mountable on
 * Hono, Bun.serve, Cloudflare Workers, Deno, or any other
 * fetch-compatible HTTP stack.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { IMcpContextRegistry } from './context-registry.js';
import { ADAPTER_SESSION_ID_HEADER, ADAPTER_SESSION_ID_PARAM } from './create-mcp-server.js';
import { MCP_INTERNAL_ERROR, mcpRouteFailureError, toMcpErrorResponse } from './mcp-http-errors.js';
import { createMcpEndpoint } from './mcp-endpoint.js';
import { trackStreamCompletion, type McpRouteResult } from './mcp-transport-registry.js';
import type { HttpMcpHandlerOptions } from './server-options.js';

/**
 * Result returned by {@link createFetchMcpHandler}.
 *
 * Provides a Web Standard fetch-compatible handler that can be mounted on any
 * HTTP stack that speaks `Request` / `Response` (Hono, Bun.serve, Cloudflare
 * Workers, Deno). See {@link createFetchMcpHandler} for usage and mounting
 * examples.
 */
export interface FetchMcpHandlerHandle {
  /**
   * Mount this on any fetch-compatible HTTP stack.
   *
   * The handler delegates body parsing to the underlying MCP transport; do not
   * pre-parse the body before passing the request to this function.
   */
  readonly handler: (request: Request) => Promise<Response>;
  /** Context registry for registering and unregistering agent sessions. */
  readonly contextRegistry: IMcpContextRegistry;
  /**
   * Gracefully close the endpoint and every MCP client session it owns.
   *
   * Idempotent: repeated calls await the same underlying close operation and
   * do not trigger a second teardown.
   */
  close(): Promise<void>;
}

/**
 * Promote the `adapterSessionId` query parameter to an `x-adapter-session-id`
 * header on a Web Standard {@link Request}.
 *
 * This is the same protocol contract as the Node handler's shim: adapters
 * pass the session ID as a query param because some HTTP clients cannot set
 * custom headers on SSE GET requests. Web Standard headers are immutable, so
 * when the param is present a new {@link Request} is returned with the header
 * added; otherwise the original request is returned unchanged.
 * @param request - Incoming request.
 * @returns The original request or a copy with the added header.
 */
function applyAdapterSessionIdShim(request: Request): Request {
  if (!request.url.includes(ADAPTER_SESSION_ID_PARAM)) return request;

  const url = new URL(request.url);
  const adapterSessionId = url.searchParams.get(ADAPTER_SESSION_ID_PARAM);
  if (!adapterSessionId) return request;

  const headers = new Headers(request.headers);
  headers.set(ADAPTER_SESSION_ID_HEADER, adapterSessionId);
  return new Request(request, { headers });
}

/**
 * Create a fetch-compatible MCP request handler backed by the Web Standard
 * {@link https://github.com/modelcontextprotocol/typescript-sdk | MCP SDK} transport.
 *
 * This is the fetch-style sibling of {@link createHttpMcpHandler}. Both share
 * the same {@link createMcpServer} wiring, but this variant uses
 * `WebStandardStreamableHTTPServerTransport` so the resulting handler accepts a
 * Web Standard `Request` and returns a `Promise<Response>`. Mount it on Hono,
 * Bun.serve, Cloudflare Workers, Deno, or any other fetch-compatible HTTP stack.
 *
 * The endpoint serves many concurrent MCP clients, one `(transport, server)`
 * pair per MCP protocol session; see `McpTransportRegistry` for the lifecycle
 * contract shared with the Node handler.
 *
 * ```ts
 * import { createFetchMcpHandler } from '@makaio/subsystem-mcp-http-server';
 *
 * const { handler, close } = await createFetchMcpHandler(bus);
 *
 * // Hono
 * app.all('/mcp', async (c) => handler(c.req.raw));
 *
 * // Bun.serve
 * Bun.serve({
 *   fetch(request) {
 *     if (new URL(request.url).pathname === '/mcp') {
 *       return handler(request);
 *     }
 *     return new Response('Not found', { status: 404 });
 *   },
 * });
 * ```
 *
 * The handler parses request bodies internally via the transport; do not
 * pre-parse or consume `request.body` before passing it in.
 * @param bus - Bus instance.
 * @param options - Handler options (same as {@link createHttpMcpHandler}).
 * @returns Handle exposing the fetch handler, context registry, and close function.
 */
export async function createFetchMcpHandler(
  bus: IMakaioBus,
  options: HttpMcpHandlerOptions = {},
): Promise<FetchMcpHandlerHandle> {
  const endpoint = createMcpEndpoint<WebStandardStreamableHTTPServerTransport>(
    bus,
    options,
    (hooks) =>
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (mcpSessionId) => hooks.onSessionInitialized(mcpSessionId),
      }),
  );

  const handler = async (request: Request): Promise<Response> => {
    // Routing is inside the error path, not ahead of it. A fetch handler has no
    // second error surface: anything that escapes here reaches the host runtime
    // as an unhandled rejection, which Workers and Deno answer with their own
    // opaque 500 instead of the JSON-RPC envelope an MCP client expects.
    let route: McpRouteResult<WebStandardStreamableHTTPServerTransport> | undefined;
    try {
      const shimmed = applyAdapterSessionIdShim(request);
      route = await endpoint.registry.route({
        method: shimmed.method,
        mcpSessionId: shimmed.headers.get('mcp-session-id') ?? undefined,
      });

      if (route.outcome !== 'dispatch') {
        return toMcpErrorResponse(mcpRouteFailureError(route.outcome));
      }

      const response = await route.transport.handleRequest(shimmed);
      if (response.body === null) {
        route.finish();
        return response;
      }
      // The activity lease is held until the body ends, so a client holding its
      // standalone SSE stream never looks idle to the reaper.
      return new Response(trackStreamCompletion(response.body, route.finish), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // A lease taken before the failure must not outlive the request that took
      // it, or the session it pins becomes unreapable.
      if (route?.outcome === 'dispatch') route.finish();
      console.error('[MCP Server] Failed to handle request:', error);
      return toMcpErrorResponse(MCP_INTERNAL_ERROR);
    }
  };

  return {
    handler,
    contextRegistry: endpoint.contextRegistry,
    close: endpoint.close,
  };
}
