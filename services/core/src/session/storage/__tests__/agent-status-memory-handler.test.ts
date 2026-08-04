/**
 * Cross-backend conformance: memory backend for the agent-status surface.
 *
 * Registers the session and agent memory handlers over one shared
 * `SessionStorageMemoryState` and drives the shared
 * `describeAgentStatusBehavior` suite.
 */
import { describe, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { registerMemorySessionStorage } from '../memory-handler.js';
import { registerMemoryAgentStorage } from '../agent-memory-handler.js';
import { createSessionStorageMemoryState } from '../memory-store.js';
import { describeAgentStatusBehavior } from './agent-status-behavior.js';

describe('registerMemoryAgentStorage status surface', () => {
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    const state = createSessionStorageMemoryState();
    cleanups = [registerMemorySessionStorage(MakaioBus, state), registerMemoryAgentStorage(MakaioBus, state)];
  });

  afterEach(() => {
    for (let index = cleanups.length - 1; index >= 0; index--) {
      cleanups[index]?.();
    }
    cleanups = [];
  });

  describeAgentStatusBehavior();
});
