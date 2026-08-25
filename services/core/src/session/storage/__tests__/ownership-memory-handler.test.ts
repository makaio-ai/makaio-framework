/**
 * Cross-backend conformance: memory backend for session ownership storage.
 *
 * Registers the three memory handlers over a single shared
 * `SessionStorageMemoryState` (so claim, session and agent stores are
 * consistent) and drives the shared `describeSessionOwnershipBehavior` suite.
 */
import { describe, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { registerMemorySessionStorage } from '../memory-handler.js';
import { registerMemoryAgentStorage } from '../agent-memory-handler.js';
import { registerMemorySessionOwnershipStorage } from '../ownership-memory-handler.js';
import { createSessionStorageMemoryState } from '../memory-store.js';
import { describeSessionOwnershipBehavior } from './session-ownership-behavior.js';
import { describeSessionOwnershipRequestNormalizationBehavior } from './session-ownership-request-normalization-behavior.js';

describe('registerMemorySessionOwnershipStorage', () => {
  let cleanups: Array<() => void> = [];
  let state: ReturnType<typeof createSessionStorageMemoryState> | undefined;

  beforeEach(() => {
    // All three handlers share the same in-memory state so writes made through
    // session and agent subjects are visible to the ownership handler and vice versa.
    state = createSessionStorageMemoryState();
    cleanups = [
      registerMemorySessionStorage(MakaioBus, state),
      registerMemoryAgentStorage(MakaioBus, state),
      registerMemorySessionOwnershipStorage(MakaioBus, state),
    ];
  });

  afterEach(() => {
    // Unregister in reverse order.
    for (let i = cleanups.length - 1; i >= 0; i--) {
      cleanups[i]?.();
    }
    cleanups = [];
  });

  describeSessionOwnershipBehavior({
    clearClaimOwnerInstanceId: (claimId) => {
      const memoryState = state;
      if (memoryState === undefined) throw new Error('memory fixture state is not initialized');
      const claim = memoryState.claims.get(claimId);
      if (claim === undefined) throw new Error(`missing claim fixture row: ${claimId}`);
      memoryState.claims.set(claimId, { ...claim, ownerInstanceId: null });
    },
  });
  describeSessionOwnershipRequestNormalizationBehavior();
});
