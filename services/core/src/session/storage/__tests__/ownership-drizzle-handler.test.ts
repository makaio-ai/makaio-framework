/**
 * Cross-backend conformance: Drizzle backend for session ownership storage.
 *
 * Provisions a fresh SQLite database per test via `useDrizzleTestLifecycle`,
 * which registers the session, agent and ownership handlers over that database.
 * The shared suite then exercises the contract identically to the
 * memory-backend suite, so any divergence between the two backends fails here or
 * there rather than in production.
 */
import { describe } from 'vitest';
import { useDrizzleTestLifecycle } from './shared.js';
import { describeSessionOwnershipBehavior } from './session-ownership-behavior.js';

describe('registerDrizzleSessionOwnershipStorage', () => {
  useDrizzleTestLifecycle();

  describeSessionOwnershipBehavior();
});
