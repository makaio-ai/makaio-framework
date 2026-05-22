/**
 * Shared test utilities for session service tests.
 *
 * Common helpers used across multiple test suites (orchestrator, logger, handlers).
 */
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import type { MakaioSessionEvent, MakaioSessionAgent, IMakaioSession } from '@makaio/contracts';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';

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
