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
import { McpContextRegistry, type IMcpContextRegistry } from './context-registry.js';
import {
  ADAPTER_SESSION_ID_HEADER,
  ADAPTER_SESSION_ID_PARAM,
  createMcpServer,
  type HttpMcpHandlerOptions,
} from './server.js';
import { connectMcpServerWithCleanup } from './mcp-server-lifecycle.js';

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
   * Gracefully close the MCP server and its transport.
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
  const contextRegistry = new McpContextRegistry();

  const sessionId = options.agentContext?.adapterSessionId ?? crypto.randomUUID();
  if (options.agentContext) {
    contextRegistry.register(sessionId, options.agentContext);
  }

  const mcpServer = await createMcpServer(bus, sessionId, {
    contextRegistry,
    toolDiscovery: options.toolDiscovery,
    resolveContextOverrides: options.resolveContextOverrides,
    toolExecutionTimeoutMs: options.toolExecutionTimeoutMs,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  if (options.onclose) {
    transport.onclose = options.onclose;
  }
  await connectMcpServerWithCleanup(mcpServer, transport, () => mcpServer.close(), 'fetch MCP handler');

  const handler = async (request: Request): Promise<Response> => {
    try {
      return await transport.handleRequest(applyAdapterSessionIdShim(request));
    } catch (error) {
      console.error('[MCP Server] Failed to handle request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  };

  let closePromise: Promise<void> | undefined;

  return {
    handler,
    contextRegistry,
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = mcpServer.close();
      }
      return closePromise;
    },
  };
}
