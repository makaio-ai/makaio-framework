import { BaseService } from '@makaio/service-base';
import type { IMakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import type { ToolExecutionContextOverrides } from '@makaio/contracts';
import QuickLRU from 'quick-lru';
import { startHttpMcpServer, type HttpMcpServerHandle } from './server.js';

/** Internal record stored per adapter session. */
interface RegisteredSession {
  /** Agent identifier. */
  agentId: string;
  /** Adapter identifier. */
  adapterId: string;
  /** Human-readable adapter name. */
  adapterName: string;
  /** Makaio session ID for tool approval routing. */
  sessionId: string;
  /** Execution context overrides forwarded to every tool execute request. */
  contextOverrides: ToolExecutionContextOverrides;
  /** Timestamp (ms) of last read or write access — used for TTL sweep. */
  lastActivity: number;
}

/** Maximum number of sessions to hold in the LRU before evicting oldest. */
export const MAX_SESSION_COUNT = 1000;
/**
 * Minimum idle time (ms) before a session is swept on the periodic tick.
 * Every MCP tool call refreshes `lastActivity` via `resolveOverrides()`,
 * so only sessions with no MCP tool calls for this duration are evicted.
 * After eviction the next tool call degrades gracefully to process defaults.
 */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Interval (ms) between TTL sweep passes. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Singleton bus service that manages the HTTP MCP server lifecycle.
 *
 * Handles `mcp.session.register` and `mcp.session.unregister` bus subjects.
 * The HTTP MCP server is started lazily on the first `session.register` call
 * using a coalescing promise so concurrent registrations never start two
 * server instances.
 *
 * The service maintains two parallel session stores:
 * - `sessions` (QuickLRU) — our own TTL/LRU tracking with `contextOverrides`
 * - `contextRegistry` (Map-backed, inside the HTTP server handle) — source of
 *   truth for the MCP server's per-request routing
 *
 * The `resolveContextOverrides` callback threaded into `startHttpMcpServer`
 * bridges these two stores so tool execution always uses session-stable
 * context overrides rather than per-process fallbacks.
 */
export class McpServerBridgeService extends BaseService {
  private mcpHandle: HttpMcpServerHandle | null = null;
  private startPromise: Promise<HttpMcpServerHandle> | null = null;
  private readonly sessions = new QuickLRU<string, RegisteredSession>({
    maxSize: MAX_SESSION_COUNT,
    onEviction: (adapterSessionId) => {
      this.mcpHandle?.contextRegistry.unregister(adapterSessionId);
    },
  });

  /**
   * @param bus - Bus instance used for handler registration.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Register bus handlers and start the TTL sweep interval.
   * @returns Promise that resolves when all handlers are registered.
   */
  protected async onInit(): Promise<void> {
    this.registerHandler(McpSubjects.session.register, async (ctx) => {
      const { adapterSessionId, agentId, adapterId, adapterName, sessionId, contextOverrides } = ctx.payload;

      const handle = await this.ensureStarted();

      handle.contextRegistry.register(adapterSessionId, {
        agentId,
        adapterId,
        adapterName,
        adapterSessionId,
        sessionId,
      });

      this.sessions.set(adapterSessionId, {
        agentId,
        adapterId,
        adapterName,
        sessionId,
        contextOverrides,
        lastActivity: Date.now(),
      });

      ctx.setResult({ port: handle.port });
    });

    // No per-registration versioning needed: adapters treat register as an
    // upsert for a given adapterSessionId. Within a single session's
    // immediate-mode rotation, unregister fires before register on the same
    // event loop, so ordering is preserved.
    this.registerHandler(McpSubjects.session.unregister, (ctx) => {
      const { adapterSessionId } = ctx.payload;
      this.sessions.delete(adapterSessionId);
      this.mcpHandle?.contextRegistry.unregister(adapterSessionId);
      ctx.setResult({});
    });

    const sweepInterval = setInterval(() => {
      const cutoff = Date.now() - SESSION_TTL_MS;
      for (const [key, entry] of this.sessions) {
        if (entry.lastActivity < cutoff) {
          this.sessions.delete(key);
          this.mcpHandle?.contextRegistry.unregister(key);
        }
      }
    }, SWEEP_INTERVAL_MS);
    // Do not prevent process exit when no other work remains.
    sweepInterval.unref();
    this.addCleanup(() => clearInterval(sweepInterval));
  }

  /**
   * Resolve context overrides for an adapter session.
   *
   * Updates `lastActivity` on access so recently-used sessions are not
   * swept by the TTL interval.
   * @param adapterSessionId - Adapter session identifier to look up.
   * @returns The stored context overrides, or `undefined` if not found.
   */
  private resolveOverrides(adapterSessionId: string): ToolExecutionContextOverrides | undefined {
    const session = this.sessions.get(adapterSessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session?.contextOverrides;
  }

  /**
   * Ensure the HTTP MCP server is running, starting it if necessary.
   *
   * Uses a coalescing promise so concurrent callers never start two servers.
   * The promise is cleared on both success and failure so a transient startup
   * error does not permanently block retries.
   * @returns The running HTTP MCP server handle.
   */
  private async ensureStarted(): Promise<HttpMcpServerHandle> {
    if (this.mcpHandle) return this.mcpHandle;
    if (this.startPromise) return this.startPromise;

    this.startPromise = startHttpMcpServer(this.bus, {
      resolveContextOverrides: (adapterSessionId) => {
        if (!adapterSessionId) return undefined;
        return this.resolveOverrides(adapterSessionId);
      },
      onclose: () => {
        this.startPromise = null;
        const handle = this.mcpHandle;
        // Best-effort cleanup: clear all sessions that were not explicitly
        // unregistered before the transport closed. The TTL sweep remains the
        // safety net, but this reduces the stale-session window to zero on
        // clean server shutdown.
        for (const [adapterSessionId] of this.sessions) {
          handle?.contextRegistry.unregister(adapterSessionId);
        }
        this.sessions.clear();
        this.mcpHandle = null;
      },
    })
      .then(async (handle) => {
        this.startPromise = null;
        if (!this.initialized) {
          // Service was destroyed while startup was in-flight — close immediately
          // and reject so callers do not receive a dead port.
          await handle.close();
          throw new Error('MCP server bridge was destroyed during startup');
        }
        this.mcpHandle = handle;
        this.addCleanup(() => handle.close());
        return handle;
      })
      .catch((error: unknown) => {
        this.startPromise = null;
        throw error;
      });

    return this.startPromise;
  }
}
