/**
 * Cross-backend conformance: Drizzle backend for the agent-status surface.
 *
 * Provisions a fresh SQLite database per test via `useDrizzleTestLifecycle`,
 * which registers the session and agent handlers over it, then drives the same
 * shared suite as the memory backend.
 */
import { describe } from 'vitest';
import { useDrizzleTestLifecycle } from './shared.js';
import { describeAgentStatusBehavior } from './agent-status-behavior.js';

describe('registerDrizzleAgentStorage status surface', () => {
  useDrizzleTestLifecycle();

  describeAgentStatusBehavior();
});
