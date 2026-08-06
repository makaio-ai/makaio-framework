/**
 * Cross-backend conformance: memory backend for agent read detachment.
 *
 * Registers the session and agent memory handlers over one shared
 * `SessionStorageMemoryState` — the session read composes agent rows through the
 * bus, so both handlers have to see the same store — and drives the shared
 * `describeAgentDetachmentBehavior` suite.
 */
import { describe, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { registerMemorySessionStorage } from '../memory-handler.js';
import { registerMemoryAgentStorage } from '../agent-memory-handler.js';
import { createSessionStorageMemoryState } from '../memory-store.js';
import { describeAgentDetachmentBehavior } from './agent-detachment-behavior.js';

describe('registerMemoryAgentStorage read detachment', () => {
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

  describeAgentDetachmentBehavior();
});
