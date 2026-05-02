import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

const _AdapterClaudeSubjectSchemas = {
  initialized: z.object({ timestamp: z.number() }),
  'sdk.thinking': z.object({ content: z.string() }),
};

// Register test namespaces for scoped bus tests
const adapterClaudeCodeNamespace = MakaioBus.registerNamespace('scopedTest:claudeCode', _AdapterClaudeSubjectSchemas);

const _AdapterClaudeSubjects = adapterClaudeCodeNamespace.subjects;

const adapterClaudeSdkNamespace = MakaioBus.registerNamespace('scopedTest:claudeCode:sdk', {
  thinking: z.object({ content: z.string() }),
});

const _AdapterClaudeSdkSubjects = adapterClaudeSdkNamespace.subjects;

const adapterOpenAINamespace = MakaioBus.registerNamespace('scopedTest:openai', {
  initialized: z.object({ timestamp: z.number() }),
});

const _AdapterOpenAISubjects = adapterOpenAINamespace.subjects;

describe('ScopedBus', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('prefix normalization', () => {
    it('converts colons to dots in prefix', async () => {
      const scopedBus = MakaioBus.scoped(adapterClaudeCodeNamespace);
      const received: string[] = [];

      const domain: string = adapterClaudeCodeNamespace.name;
      expect(domain).toBe('scopedTest:claudeCode');

      // Subscribe via global bus with normalized path
      MakaioBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        received.push(payload.timestamp.toString());
      });

      // Emit via scoped bus
      await scopedBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 12345 });

      expect(received).toEqual(['12345']);
    });

    it('handles multiple levels of nesting', async () => {
      const scopedBus = MakaioBus.scoped(adapterClaudeSdkNamespace);
      const received: unknown[] = [];

      // Subscribe via global bus
      MakaioBus.on(_AdapterClaudeSdkSubjects.thinking, ({ payload }) => {
        received.push(payload);
      });

      // Emit via scoped bus
      await scopedBus.emit(_AdapterClaudeSdkSubjects.thinking, { content: 'analyzing...' });

      expect(received).toEqual([{ content: 'analyzing...' }]);
    });
  });

  describe('scoped and global subscriptions work together', () => {
    it('allows subscribing via scoped bus and emitting via global bus', async () => {
      const scopedBus = MakaioBus.scoped(adapterClaudeCodeNamespace);
      const received: unknown[] = [];

      // Subscribe via scoped bus
      scopedBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        received.push(payload);
      });

      // Emit via global bus
      await MakaioBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 12345 });

      expect(received).toEqual([{ timestamp: 12345 }]);
    });

    it('allows subscribing via global bus and emitting via scoped bus', async () => {
      const scopedBus = MakaioBus.scoped(adapterClaudeCodeNamespace);
      const received: unknown[] = [];

      // Subscribe via global bus
      MakaioBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        received.push(payload);
      });

      // Emit via scoped bus
      await scopedBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 67890 });

      expect(received).toEqual([{ timestamp: 67890 }]);
    });

    it('both scoped and global handlers receive the same event', async () => {
      const scopedBus = MakaioBus.scoped(adapterClaudeCodeNamespace);
      const scopedReceived: unknown[] = [];
      const globalReceived: unknown[] = [];

      // Subscribe via scoped bus
      scopedBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        scopedReceived.push(payload);
      });

      // Subscribe via global bus
      MakaioBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        globalReceived.push(payload);
      });

      // Emit via scoped bus
      await scopedBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 11111 });

      // Both handlers should receive the event
      expect(scopedReceived).toEqual([{ timestamp: 11111 }]);
      expect(globalReceived).toEqual([{ timestamp: 11111 }]);

      // Clear and emit via global bus
      scopedReceived.length = 0;
      globalReceived.length = 0;
      await MakaioBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 22222 });

      // Both handlers should receive the event again
      expect(scopedReceived).toEqual([{ timestamp: 22222 }]);
      expect(globalReceived).toEqual([{ timestamp: 22222 }]);
    });
  });

  // Note: Request tests are omitted as they require proper type scaffolding.
  // The scoped bus forwards all calls to MakaioBus, so request() works the same way
  // as emit() and on() - it just prefixes the subject.

  describe('unsubscribe', () => {
    it('returns unsubscribe function that works correctly', async () => {
      const scopedBus = MakaioBus.scoped(adapterClaudeCodeNamespace);
      const received: unknown[] = [];

      // Subscribe via scoped bus
      const unsubscribe = scopedBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        received.push(payload);
      });

      // Emit - handler should receive
      await scopedBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 1 });
      expect(received).toEqual([{ timestamp: 1 }]);

      // Unsubscribe
      unsubscribe();

      // Emit again - handler should not receive
      await scopedBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: 2 });
      expect(received).toEqual([{ timestamp: 1 }]);
    });
  });

  describe('namespace isolation', () => {
    it('scoped buses with different prefixes are isolated', async () => {
      const scopedBusA = MakaioBus.scoped(adapterClaudeCodeNamespace);
      const scopedBusB = MakaioBus.scoped(adapterOpenAINamespace);

      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];

      scopedBusA.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        receivedA.push(payload);
      });

      scopedBusB.on(_AdapterOpenAISubjects.initialized, ({ payload }) => {
        receivedB.push(payload);
      });

      // Emit to Claude bus
      await scopedBusA.emit(_AdapterClaudeSubjects.initialized, { timestamp: 1 });

      expect(receivedA).toEqual([{ timestamp: 1 }]);
      expect(receivedB).toEqual([]); // Should not receive

      // Emit to OpenAI bus
      await scopedBusB.emit(_AdapterOpenAISubjects.initialized, { timestamp: 2 });

      expect(receivedA).toEqual([{ timestamp: 1 }]); // Should not receive new event
      expect(receivedB).toEqual([{ timestamp: 2 }]);
    });
  });

  describe('adapter use case', () => {
    it('demonstrates adapter emitting SDK events through scoped bus', async () => {
      // Create scoped bus for adapter (like in createAdapter factory)
      const adapterBus = MakaioBus.scoped(adapterClaudeCodeNamespace);

      const sdkEvents: unknown[] = [];
      const allAdapterEvents: unknown[] = [];

      // Plugin subscribes to SDK events via global bus
      MakaioBus.on(_AdapterClaudeSubjects.sdk.thinking, ({ payload }) => {
        sdkEvents.push(payload);
      });

      // Plugin subscribes to all adapter events via global bus
      MakaioBus.on(_AdapterClaudeSubjects.initialized, ({ payload }) => {
        allAdapterEvents.push(payload);
      });

      // Adapter emits through scoped bus (clean internal code)
      await adapterBus.emit(_AdapterClaudeSubjects.initialized, { timestamp: Date.now() });
      await adapterBus.emit(_AdapterClaudeSubjects.sdk.thinking, { content: 'analyzing...' });

      expect(allAdapterEvents).toHaveLength(1);
      expect(sdkEvents).toHaveLength(1);
      expect(sdkEvents[0]).toEqual({ content: 'analyzing...' });
    });
  });
});
