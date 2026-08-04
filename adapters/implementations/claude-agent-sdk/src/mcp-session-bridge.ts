import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import type { ClaudeSessionConfig } from './types/index.js';

/**
 * Owns one session's registration with the singleton MCP bridge service.
 *
 * Registration is what makes the in-process HTTP MCP server reachable for a
 * provider session: the bridge answers with the port the session must advertise
 * in its SDK query options. That port is therefore registration-scoped state,
 * and holding it next to the registered provider session ID is what lets a
 * rotation (unregister, then register the successor session) fall back to the
 * config-seeded port instead of carrying the retired session's one.
 *
 * Degrades gracefully: when the bridge service is not running, registration
 * reports no port and the session runs without the Makaio MCP proxy.
 */
export class McpSessionRegistration {
  private readonly config: ClaudeSessionConfig;

  /** Provider session ID currently registered with the bridge, if any. */
  private registeredSessionId?: string;

  /** Bridge-reported port; seeded from config until a registration answers. */
  private port?: number;

  /**
   * Create a registration bound to one session's config.
   * @param config - Session config supplying agent/adapter identity, context overrides and the seeded port
   */
  public constructor(config: ClaudeSessionConfig) {
    this.config = config;
    this.port = config.mcpServerPort;
  }

  /** @returns MCP server port for query options, or `undefined` when MCP is unavailable */
  public get serverPort(): number | undefined {
    return this.port;
  }

  /** @returns Whether a provider session is currently registered with the bridge */
  public get isRegistered(): boolean {
    return this.registeredSessionId !== undefined;
  }

  /**
   * Register a provider session with the bridge service via bus RPC.
   *
   * MakaioBus (global singleton) is intentional here — MCP subjects live in the
   * `mcp` namespace, which is unreachable from the adapter's scoped bus. Same
   * pattern used by ToolSubjects.execute and AgentSubjects throughout the
   * adapter layer for all cross-namespace RPCs.
   * @param adapterSessionId - Provider session ID to register; no-op without one
   * @returns Whether registration produced a port that differs from the previous one
   */
  public async register(adapterSessionId: string | undefined): Promise<boolean> {
    if (!adapterSessionId) {
      return false;
    }
    const previousPort = this.port;
    this.registeredSessionId = adapterSessionId;
    const makaioSessionId = this.config.sessionId ?? adapterSessionId;
    const result = await MakaioBus.requestOptional(McpSubjects.session.register, {
      adapterSessionId,
      agentId: this.config.agentId,
      adapterId: this.config.adapterId,
      adapterName: this.config.adapterName,
      sessionId: makaioSessionId,
      contextOverrides: {
        cwd: this.config.cwd,
        env: this.config.contextEnv ?? {},
        sessionId: makaioSessionId,
        agentId: this.config.agentId,
        adapterSessionId,
      },
    });
    // A concurrent unregister() or a newer register() may have superseded this
    // registration while the RPC was in flight — an out-of-order response must
    // not resurrect the superseded registration's port.
    if (this.registeredSessionId !== adapterSessionId) {
      return false;
    }
    if (result.handled) {
      this.port = result.data.port;
    }
    return this.port !== previousPort && this.port !== undefined;
  }

  /**
   * Unregister the currently registered session and drop its bridge port.
   *
   * Fire-and-forget: errors are swallowed to avoid masking the close/abort path.
   */
  public unregister(): void {
    const adapterSessionId = this.registeredSessionId;
    if (!adapterSessionId) {
      return;
    }
    this.registeredSessionId = undefined;
    this.port = this.config.mcpServerPort;
    void MakaioBus.requestOptional(McpSubjects.session.unregister, {
      adapterSessionId,
    }).catch(() => {
      // Best-effort cleanup — ignore bridge failures during teardown.
    });
  }
}
