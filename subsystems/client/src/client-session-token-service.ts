/**
 * In-memory store for session correlation tokens.
 *
 * Records tokens produced by `session.token` canonical effects at
 * `SessionStart`/`SubagentStart` hook time and serves them on demand via the
 * bus so that MCP servers can retrieve the token for the active adapter
 * session.
 *
 * The token is handed over **in-process** via the {@link ClientSessionTokenSink}
 * interface — never as a bus payload — so the `MAKAIO_DEBUG` bus logger never
 * sees the token value.
 *
 * Subjects handled:
 * - `client.session.token.get` (normal bus request) — retrieves the token for
 *   a given scope, or `null` when none has been recorded.
 *
 * The `client.session.subagent.completed` cleanup handler has been removed
 * because no client currently declares `session.token` on `SubagentStart`.
 * The key builder retains the `agentId` dimension so a client whose MCP
 * consumers can learn an agent id may declare `SubagentStart` later without a
 * contract change; the completion-cleanup handler would come back with it.
 *
 * Lifetime:
 * - All entries are swept by a periodic TTL pass; entries idle for more than
 *   {@link SESSION_TOKEN_TTL_MS} are evicted. Session-scoped entries have no
 *   dedicated end event (`client.session.ended` does not exist today) and rely
 *   on this TTL.
 * - The store is capped at {@link MAX_SESSION_TOKEN_COUNT} entries; on insert
 *   beyond the cap the least recently active entry is evicted (Map insertion
 *   order is used: delete-and-re-insert on access moves an entry to the end,
 *   making the first entry the LRU).
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientSessionTokenScope } from '@makaio/contracts/client';
import { ClientSubjects } from '@makaio/contracts/client';
import { BaseService } from '@makaio/service-base';

// ---------------------------------------------------------------------------
// Exported constants (used in tests)
// ---------------------------------------------------------------------------

/**
 * Idle duration (ms) after which an entry is evicted by the sweep timer.
 *
 * Tokens are fetched by MCP servers at their spawn time. `SessionStart`
 * re-records on resume, clear, and compact, so a session that truly goes
 * quiet for 24 hours can be safely assumed to have ended.
 */
export const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Interval (ms) between TTL sweep passes. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Maximum number of token entries held in memory.
 *
 * On insert beyond this cap the least recently active entry (first Map entry
 * after LRU reordering) is evicted before the new entry is stored.
 */
export const MAX_SESSION_TOKEN_COUNT = 1000;

// ---------------------------------------------------------------------------
// Public sink interface
// ---------------------------------------------------------------------------

/**
 * Narrow write-only interface for recording session correlation tokens.
 *
 * Client services receive this interface injected from clients-core and call
 * it directly — the token is never placed on the bus so the `MAKAIO_DEBUG`
 * bus logger never sees the token value.
 */
export interface ClientSessionTokenSink {
  /**
   * Upsert a correlation token for the given scope.
   *
   * A later call for the same scope overwrites the previous entry — the
   * intended compaction path when `SessionStart` fires again with
   * `startMode: 'compact'`.
   */
  record(scope: ClientSessionTokenScope, token: string): void;
}

// ---------------------------------------------------------------------------
// Internal store entry
// ---------------------------------------------------------------------------

/** One recorded token entry in the in-memory store. */
interface TokenEntry {
  /** The opaque correlation token value. */
  readonly token: string;
  /**
   * Unix epoch milliseconds at which this entry was last read or written.
   *
   * Refreshed on every `record` and `get` call. Used by both the TTL sweep
   * and the LRU eviction path.
   */
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * In-process token store for `client.session.token.*` subjects.
 *
 * Tokens are written via the public {@link record} method (called directly by
 * the client service that produced the token, never over the bus) and read via
 * the `client.session.token.get` bus handler (reachable by remote MCP servers
 * over the WebSocket bus).
 *
 * Keeps tokens in memory keyed by adapter session id and an optional agent id.
 * A later {@link record} call for the same key overwrites the previous entry —
 * the intended compaction path when `SessionStart` fires again with
 * `startMode: 'compact'`.
 *
 * Access (both {@link record} and `get`) refreshes `lastActivity` and reorders
 * the entry to the Map tail so Map insertion order always reflects recency: the
 * first Map entry is the least recently active (LRU) and is evicted first when
 * the store exceeds {@link MAX_SESSION_TOKEN_COUNT}.
 *
 * The `agentId` dimension in the key builder is retained even though no client
 * currently declares `session.token` on `SubagentStart`. A client whose MCP
 * consumers can learn an agent id may declare `SubagentStart` later without a
 * contract change; the completion-cleanup handler would come back with it.
 */
export class ClientSessionTokenService extends BaseService implements ClientSessionTokenSink {
  /**
   * In-memory token store.
   *
   * Key: output of {@link buildKey}.
   * Value: the stored token entry.
   *
   * Map insertion order is used as an LRU indicator: every access calls
   * {@link touchEntry}, which deletes and re-inserts the entry to move it to
   * the tail. The head of the Map is therefore always the LRU entry.
   */
  private readonly store = new Map<string, TokenEntry>();

  /**
   * @param bus - Bus instance used for handler registration
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Upsert a correlation token for the given scope.
   *
   * Called in-process by the client service that received the hook — the token
   * is handed over directly so no bus payload (and no `MAKAIO_DEBUG` bus
   * logger) ever sees it.
   *
   * A later call for the same scope overwrites the previous entry — the
   * intended compaction path when `SessionStart` fires again with
   * `startMode: 'compact'`. Never log the token value.
   * @param scope - Scope identifying the session (or subagent) that produced
   *   the token.
   * @param token - The opaque correlation token to store.
   */
  public record(scope: ClientSessionTokenScope, token: string): void {
    const { clientId, adapterSessionId, agentId } = scope;
    const key = this.buildKey(clientId, adapterSessionId, agentId);
    const existing = this.store.get(key);
    if (existing !== undefined) {
      // Existing entry: delete so re-insert moves it to the Map tail.
      this.store.delete(key);
    } else if (this.store.size >= MAX_SESSION_TOKEN_COUNT) {
      // Cap exceeded: evict the least recently active entry (Map head).
      // A Map's keys() iterator follows insertion order, so the first key
      // is the LRU after the delete-and-re-insert pattern is applied on
      // every access.  Never log the evicted token value.
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      }
    }
    // Upsert — a later record overwrites a previous one.  This is the
    // compaction path: SessionStart fires again with startMode: 'compact'
    // and the hook handler re-delivers the token for the same adapter
    // session.  Never log the token value.
    this.store.set(key, { token, lastActivity: Date.now() });
  }

  /**
   * Register bus handlers and start the TTL sweep timer.
   */
  protected override onInit(): void {
    this.registerHandler(ClientSubjects.session.token.get, (ctx) => {
      const { clientId, adapterSessionId, agentId } = ctx.payload;
      const key = this.buildKey(clientId, adapterSessionId, agentId);
      const entry = this.store.get(key);
      if (entry !== undefined) {
        // Refresh access time and reorder to Map tail (LRU bookkeeping).
        this.store.delete(key);
        this.store.set(key, { token: entry.token, lastActivity: Date.now() });
      }
      // No silent fallback from subagent scope to session scope.  A subagent
      // lookup without a recorded subagent token returns null because the token
      // identifies the generation/agent — silently returning the parent-session
      // token would mis-attribute the correlation.
      ctx.setResult({ token: entry?.token ?? null });
    });

    const sweepInterval = setInterval(() => {
      const cutoff = Date.now() - SESSION_TOKEN_TTL_MS;
      for (const [key, entry] of this.store) {
        if (entry.lastActivity < cutoff) {
          this.store.delete(key);
        }
      }
    }, SWEEP_INTERVAL_MS);
    // Do not prevent process exit when no other work remains.
    sweepInterval.unref();
    this.addCleanup(() => clearInterval(sweepInterval));
  }

  /**
   * Clear the in-memory store on teardown.
   */
  protected override onDestroy(): void {
    this.store.clear();
  }

  /**
   * Build the lookup key for the in-memory store.
   *
   * The key always includes the client id so that two client providers that
   * share the same provider-local session id cannot collide in the store, and
   * a subagent-completion event for one client cannot delete the entry of
   * another. When an agent id is present, it is appended so that a subagent
   * token does not collide with or shadow the parent-session token.
   * @param clientId - Stable client identity (e.g. `'claude-code'`, `'codex'`).
   * @param adapterSessionId - Hook payload `session_id` from the client runtime.
   * @param agentId - Present for SubagentStart events; absent for top-level
   *   SessionStart events.
   * @returns Composite key string for use in {@link store}.
   */
  private buildKey(clientId: string, adapterSessionId: string, agentId?: string): string {
    const base = `${clientId}\n${adapterSessionId}`;
    return agentId !== undefined ? `${base}\n${agentId}` : base;
  }
}
