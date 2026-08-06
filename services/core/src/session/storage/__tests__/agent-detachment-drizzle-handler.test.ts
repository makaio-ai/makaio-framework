/**
 * Cross-backend conformance: Drizzle backend for agent read detachment.
 *
 * Provisions a fresh SQLite database per test via `useDrizzleTestLifecycle` and
 * drives the same shared suite as the memory backend. This side is expected to
 * be green unchanged — every row a SQL read returns is materialised — and that is
 * the point: it is the assertion that the two backends now agree, which is what
 * makes a test written against the memory store mean something.
 */
import { describe } from 'vitest';
import { useDrizzleTestLifecycle } from './shared.js';
import { describeAgentDetachmentBehavior } from './agent-detachment-behavior.js';

describe('registerDrizzleAgentStorage read detachment', () => {
  useDrizzleTestLifecycle();

  describeAgentDetachmentBehavior();
});
