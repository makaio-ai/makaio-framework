/**
 * The bounded ACP handshake performed once per Qwen connection generation.
 * @packageDocumentation
 */

import type { InitializeRequest, McpServer, NewSessionRequest, NewSessionResponse } from '@agentclientprotocol/sdk';
import { withTimeout } from '@makaio/ai-adapters-core';

/**
 * The two calls this handshake makes on a live ACP connection.
 *
 * Narrower than the connection type on purpose: the handshake depends on the
 * requests it issues, not on everything a connection can do, so its contract
 * states exactly what a peer has to answer.
 */
export interface AcpHandshakePeer {
  /**
   * Negotiate protocol version and client capabilities.
   * @param params - Client identity and capability advertisement.
   * @returns The peer's negotiated response.
   */
  initialize(params: InitializeRequest): Promise<unknown>;
  /**
   * Open a session on the negotiated connection.
   * @param params - Session working directory and MCP servers.
   * @returns The peer's session response, carrying its identifier.
   */
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
}

/** Inputs for {@link performAcpHandshake}. */
export interface AcpHandshakeOptions {
  /** Working directory the ACP session is opened against. */
  readonly cwd: string;
  /** Upstream MCP servers threaded into the ACP session. */
  readonly mcpServers: McpServer[];
  /**
   * Milliseconds each round trip may take.
   *
   * Applied per phase rather than to the handshake as a whole, because the
   * budget answers "is this peer still answering me", which is a question about
   * one request and not about the sum of them.
   */
  readonly budgetMs: number;
}

/**
 * Negotiate protocol capabilities and open a session on a live ACP connection.
 *
 * Both round trips are bounded. An ACP peer that accepts the connection and
 * then never answers is indistinguishable from a slow one, so an unbounded wait
 * here is an unbounded wait for every caller queued behind the start — including
 * a teardown, which then cannot complete either. The budget is the caller's, so
 * an adapter honours the value it already declares instead of carrying it as
 * unused metadata.
 * @param peer - Live ACP connection being negotiated with.
 * @param options - Session target, MCP servers, and the per-phase budget.
 * @returns The ACP session identifier assigned by the peer.
 * @throws Error when either phase fails or exceeds the budget.
 */
export async function performAcpHandshake(
  peer: AcpHandshakePeer,
  options: AcpHandshakeOptions,
): Promise<{ sessionId: string }> {
  await withTimeout(
    peer.initialize({
      clientInfo: { name: 'makaio', version: '0.1.0' },
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    }),
    options.budgetMs,
    'Qwen ACP initialize did not answer within the initialization budget.',
  );

  const session = await withTimeout(
    peer.newSession({ cwd: options.cwd, mcpServers: options.mcpServers }),
    options.budgetMs,
    'Qwen ACP newSession did not answer within the initialization budget.',
  );

  return { sessionId: session.sessionId };
}
