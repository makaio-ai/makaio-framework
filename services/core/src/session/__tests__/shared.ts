/**
 * Shared test utilities for session service tests.
 *
 * Common helpers used across multiple test suites (orchestrator, logger, handlers).
 */
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import type { MakaioSessionEvent, MakaioSessionAgent, IMakaioSession } from '@makaio/contracts';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { registerMemoryAgentStorage } from '../storage/agent-memory-handler.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { createSessionStorageMemoryState } from '../storage/memory-store.js';
import { registerMemorySessionOwnershipStorage } from '../storage/ownership-memory-handler.js';

// =============================================================================
// Common Test Utilities
// =============================================================================

/**
 * Resets all bus handlers between tests.
 * Uses the internal __resetHandlers method available in test environment.
 */
export function resetBusHandlers(): void {
  MakaioBus.__resetHandlers?.();
}

/**
 * Wait for async handler processing to complete.
 * Useful for event-driven handlers that execute asynchronously.
 * @param ms - Milliseconds to wait (default 10ms)
 */
export function waitForAsync(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Let every queued bus round-trip drain.
 *
 * For assertions about what a *pending* request has **not** done yet: a single
 * `waitForAsync` covers one hop, while a send or a restart walks several
 * storage round-trips before it reaches the step under test — and an assertion
 * that fires too early passes for the wrong reason.
 * @returns Promise resolving once the queue is idle.
 */
export async function settleEventLoop(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await waitForAsync(1);
}

// =============================================================================
// Real Storage Backends
// =============================================================================

/**
 * Register the session, agent and ownership memory backends over **one** state.
 *
 * They share a store because the ownership handler reads and writes the very
 * session and agent rows the other two own: a reservation verifies the
 * `(agent, session)` pair, a designation is a compare-and-swap on the session
 * row, and a settlement mirrors onto it. Registered over separate stores, every
 * ownership operation reports `not-found` instead — the failure this helper
 * exists to make unrepeatable.
 *
 * Composes with `registerMockStorageHandlers({ omit: ['agent', 'session'] })`:
 * request handlers form one chain, so a stub registered for those groups would
 * answer ahead of the backend under test.
 * @param bus - Bus the backends are registered on.
 * @returns Cleanup functions, one per registered backend.
 */
export function registerMemorySessionBackends(bus: IMakaioBus): Array<() => void> {
  const state = createSessionStorageMemoryState();
  return [
    registerMemorySessionStorage(bus, state),
    registerMemoryAgentStorage(bus, state),
    registerMemorySessionOwnershipStorage(bus, state),
  ];
}

// =============================================================================
// Agent / Session Factory Helpers
// =============================================================================

/**
 * Creates a test agent with sensible defaults.
 * @param agentId - The agent identifier
 * @param overrides - Optional overrides for agent properties
 * @returns A MakaioSessionAgent for testing
 */
export function createTestAgent(agentId: string, overrides?: Partial<MakaioSessionAgent>): MakaioSessionAgent {
  const now = Date.now();
  return {
    agentId,
    adapterId: `adapter-${agentId}`,
    adapterName: 'test-adapter',
    sessionId: overrides?.sessionId ?? 'test-session',
    role: 'member',
    status: 'idle',
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

/**
 * Creates a test session with sensible defaults.
 * @param sessionId - The session identifier
 * @param overrides - Optional overrides for session properties
 * @returns An IMakaioSession for testing
 */
export function createTestSession(sessionId: string, overrides?: Partial<IMakaioSession>): IMakaioSession {
  return {
    sessionId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    status: 'active',
    agents: [],
    ...overrides,
  };
}

// =============================================================================
// Adapter Utilities
// =============================================================================

/**
 * Emit `adapter.initialized` for tests that intentionally exercise the
 * AdapterRegistry event cache or reverse adapter-name lookup.
 *
 * The framework `SessionOrchestrator` resolves name-based routing through
 * `AdapterRuntimeSubjects.resolveId`; auto-attach tests should prefer mock
 * runtime identity handlers unless they specifically need the event cache.
 * @param adapterName - Adapter type name (e.g., `'test-adapter'`)
 * @param adapterId - Adapter instance ID. Defaults to `adapterName` for test simplicity.
 */
export async function emitAdapterInitialized(adapterName: string, adapterId = adapterName): Promise<void> {
  await MakaioBus.emit(AdapterSubjects.initialized, {
    adapterName,
    adapterId,
    capabilities: [],
  });
}

// =============================================================================
// Session Event Utilities
// =============================================================================

/**
 * Query stored session events.
 * @param sessionId - Session ID to query
 * @returns Array of stored events
 */
export async function getStoredEvents(sessionId: string): Promise<MakaioSessionEvent[]> {
  const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
    sessionId,
  });
  return result.events;
}
