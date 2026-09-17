/**
 * Session correlation-token schemas for the client domain.
 *
 * Covers the scope, get-request, and get-response schemas for
 * `client.session.token.get`.
 *
 * The token is handed to the runtime **in-process** via
 * {@link ClientSessionTokenSink} — it is never placed on the bus, so the
 * `MAKAIO_DEBUG` bus logger never sees the token value. The runtime serves the
 * token on `client.session.token.get` so that MCP servers can retrieve it over
 * the WebSocket bus by adapter session id.
 *
 * Subjects:
 * `client.session.token.get`.
 * @packageDocumentation
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Scope that identifies a session (or a subagent within a session) for token
 * operations.
 *
 * - `clientId` — stable string identity of the client that produced the hook
 *   (e.g. `'claude-code'`, `'codex'`). Two client providers may report the
 *   same provider-local session id; including the client id in the key
 *   prevents a Codex record from overwriting a Claude Code token, and prevents
 *   a subagent-completion event from one client from deleting the other's
 *   entry. An MCP server that runs under Claude Code knows it belongs to that
 *   client because `CLAUDE_CODE_SESSION_ID` is set in its environment.
 * - `adapterSessionId` — Claude Code hook payload `session_id`; equals
 *   `CLAUDE_CODE_SESSION_ID` in stdio MCP servers.
 * - `agentId` — present only for SubagentStart events; absent for
 *   top-level SessionStart events.
 */
export const ClientSessionTokenScopeSchema = z.object({
  /**
   * Stable client identity that produced the hook
   * (e.g. `'claude-code'`, `'codex'`).
   *
   * Required to prevent two client providers that share a provider-local
   * session id from colliding in the token store.
   */
  clientId: z.string().min(1),
  /**
   * Raw session identifier from the client runtime.
   *
   * For Claude Code this is the hook payload `session_id`, and it equals
   * `CLAUDE_CODE_SESSION_ID` as exposed to stdio MCP servers.
   */
  adapterSessionId: z.string().min(1),
  /**
   * Client-native agent identity. Present only for SubagentStart hook events;
   * absent for top-level SessionStart events.
   */
  agentId: z.string().min(1).optional(),
});

export type ClientSessionTokenScope = z.infer<typeof ClientSessionTokenScopeSchema>;

// ---------------------------------------------------------------------------
// Get (normal request — called by remote MCP servers over the bus)
// ---------------------------------------------------------------------------

/**
 * Request payload for `client.session.token.get`.
 *
 * Issued by MCP servers over the WebSocket bus to retrieve a previously
 * recorded correlation token by its scope.
 */
export const ClientSessionTokenGetRequestSchema = ClientSessionTokenScopeSchema;

export type ClientSessionTokenGetRequest = z.infer<typeof ClientSessionTokenGetRequestSchema>;

/**
 * Response payload for `client.session.token.get`.
 *
 * Returns the stored token, or `null` when no token has been recorded for
 * the given scope (e.g. no SessionToken effect was contributed at hook time).
 */
export const ClientSessionTokenGetResponseSchema = z.object({
  /**
   * The stored correlation token, or `null` when none exists for the given
   * scope.
   */
  token: z.string().nullable(),
});

export type ClientSessionTokenGetResponse = z.infer<typeof ClientSessionTokenGetResponseSchema>;
