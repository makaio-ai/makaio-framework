/**
 * Wire-level error vocabulary shared by the Node and fetch MCP handlers.
 *
 * Both handlers route requests through the same MCP transport registry, so
 * both must answer a failed route with the same status and JSON-RPC error.
 * Keeping the mapping here is what stops the two transports from drifting.
 *
 * Every status/code pair mirrors an error the MCP SDK transport itself emits
 * for the equivalent situation, so a client cannot distinguish "the registry
 * refused to route" from "the transport refused to serve".
 */

import type { ServerResponse } from 'node:http';

/** Reasons the registry declined to dispatch a request to a transport. */
export type McpRouteFailure = 'unknown-session' | 'session-id-required' | 'closed' | 'create-failed';

/** JSON-RPC 2.0 error envelope returned for a request that was never dispatched. */
export interface JsonRpcErrorBody {
  readonly jsonrpc: '2.0';
  readonly error: { readonly code: number; readonly message: string };
  readonly id: null;
}

/** An HTTP status paired with the JSON-RPC body to return alongside it. */
export interface McpHttpError {
  readonly status: number;
  readonly body: JsonRpcErrorBody;
}

/**
 * Build an HTTP-status-plus-JSON-RPC error pair.
 * @param status - HTTP status code to return.
 * @param code - JSON-RPC error code.
 * @param message - Human-readable JSON-RPC error message.
 * @returns The paired HTTP status and JSON-RPC error body.
 */
export function jsonRpcError(status: number, code: number, message: string): McpHttpError {
  return { status, body: { jsonrpc: '2.0', error: { code, message }, id: null } };
}

/** Session ID was supplied but no live session owns it (expired, reaped, or terminated). */
export const MCP_SESSION_NOT_FOUND = jsonRpcError(404, -32001, 'Session not found');

/** A method that can never open a session was sent without a session ID. */
export const MCP_SESSION_ID_REQUIRED = jsonRpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');

/** The endpoint is closing, so no new work is accepted. */
export const MCP_SERVER_SHUTTING_DOWN = jsonRpcError(503, -32000, 'Server is shutting down');

/** Building or connecting a session failed. */
export const MCP_INTERNAL_ERROR = jsonRpcError(500, -32603, 'Internal server error');

/**
 * Map a routing failure to the response both handlers must return for it.
 * @param failure - Reason the registry declined to dispatch.
 * @returns The paired HTTP status and JSON-RPC error body.
 */
export function mcpRouteFailureError(failure: McpRouteFailure): McpHttpError {
  switch (failure) {
    case 'unknown-session':
      return MCP_SESSION_NOT_FOUND;
    case 'session-id-required':
      return MCP_SESSION_ID_REQUIRED;
    case 'closed':
      return MCP_SERVER_SHUTTING_DOWN;
    case 'create-failed':
      return MCP_INTERNAL_ERROR;
  }
}

/**
 * Write an MCP error onto a Node response.
 * @param res - Node response to write to; must not have sent headers yet.
 * @param error - Status and JSON-RPC body to emit.
 */
export function writeMcpHttpError(res: ServerResponse, error: McpHttpError): void {
  res.writeHead(error.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(error.body));
}

/**
 * Convert an MCP error to a Web Standard response.
 * @param error - Status and JSON-RPC body to emit.
 * @returns Response carrying the JSON-RPC error body.
 */
export function toMcpErrorResponse(error: McpHttpError): Response {
  return new Response(JSON.stringify(error.body), {
    status: error.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
