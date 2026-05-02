import { describe, it, expect, vi } from 'vitest';
import { AgentSubjects } from '@makaio/contracts';
import {
  defineDiscriminatedHandlers,
  processDiscriminatedItems,
  processDiscriminatedItemsSync,
  type TypedEmitFn,
  type SyncTypedEmitFn,
} from '../../utils/discriminated-handlers.js';

// Test discriminated union type
type TestBlock =
  | { type: 'text'; content: string }
  | { type: 'number'; value: number }
  | { type: 'complex'; nested: { data: string } };

// Collected emit call for assertions
interface EmitCall {
  subject: unknown;
  payload: unknown;
}

// Mock emit that collects calls (async-compatible)
function createMockEmit() {
  const calls: EmitCall[] = [];
  const emit: TypedEmitFn = (subject, payload) => {
    calls.push({ subject, payload });
  };
  return { emit, calls };
}

// Mock sync emit (for processDiscriminatedItemsSync)
function createSyncMockEmit() {
  const calls: EmitCall[] = [];
  const emit: SyncTypedEmitFn = (subject, payload) => {
    calls.push({ subject, payload });
  };
  return { emit, calls };
}

// Mock async emit
function createAsyncMockEmit() {
  const calls: EmitCall[] = [];
  const emit: TypedEmitFn = async (subject, payload) => {
    await Promise.resolve();
    calls.push({ subject, payload });
  };
  return { emit, calls };
}

describe('defineDiscriminatedHandlers', () => {
  it('should return config with discriminator and handlers', () => {
    const config = defineDiscriminatedHandlers<TestBlock>('type', {
      text: (_block, _emit) => {},
    });

    expect(config.discriminator).toBe('type');
    expect(config.handlers).toHaveProperty('text');
  });

  it('should allow partial handler coverage', () => {
    const config = defineDiscriminatedHandlers<TestBlock>('type', {
      text: (_block, _emit) => {},
      // number and complex not defined - should compile fine
    });

    expect(config.handlers.text).toBeDefined();
    expect(config.handlers.number).toBeUndefined();
    expect(config.handlers.complex).toBeUndefined();
  });
});

describe('processDiscriminatedItems', () => {
  describe('happy path', () => {
    it('should call handler with narrowed payload', async () => {
      const { emit, calls } = createMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: (block, emit) => emit(AgentSubjects.message, { content: block.content }),
        number: (block, emit) => emit(AgentSubjects.message, { content: String(block.value) }),
      });

      await processDiscriminatedItems({ type: 'text', content: 'hello' }, config, emit);

      expect(calls).toHaveLength(1);
      expect(calls[0].subject).toBe(AgentSubjects.message);
      expect(calls[0].payload).toEqual({ content: 'hello' });
    });

    it('should process array of items in order', async () => {
      const { emit, calls } = createMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: (block, emit) => emit(AgentSubjects.message, { content: block.content }),
        number: (block, emit) => emit(AgentSubjects.message, { content: String(block.value) }),
      });

      const items: TestBlock[] = [
        { type: 'text', content: 'first' },
        { type: 'number', value: 42 },
        { type: 'text', content: 'third' },
      ];

      await processDiscriminatedItems(items, config, emit);

      expect(calls).toHaveLength(3);
      expect(calls[0].payload).toEqual({ content: 'first' });
      expect(calls[1].payload).toEqual({ content: '42' });
      expect(calls[2].payload).toEqual({ content: 'third' });
    });

    it('should await async handlers', async () => {
      const order: string[] = [];
      const { emit } = createAsyncMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: async (block, emit) => {
          order.push(`start-${block.content}`);
          await emit(AgentSubjects.message, { content: block.content });
          order.push(`end-${block.content}`);
        },
      });

      const items: TestBlock[] = [
        { type: 'text', content: 'a' },
        { type: 'text', content: 'b' },
      ];

      await processDiscriminatedItems(items, config, emit);

      // Should process sequentially, not in parallel
      expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b']);
    });
  });

  describe('edge cases', () => {
    it('should be no-op for empty array', async () => {
      const { emit, calls } = createMockEmit();
      const handler = vi.fn();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: handler,
      });

      await processDiscriminatedItems([], config, emit);

      expect(handler).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    it('should skip items with unknown discriminator value', async () => {
      const { emit, calls } = createMockEmit();
      const textHandler = vi.fn();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: textHandler,
        // number handler not defined
      });

      const items: TestBlock[] = [
        { type: 'text', content: 'handled' },
        { type: 'number', value: 42 }, // no handler - should skip
        { type: 'complex', nested: { data: 'also skipped' } }, // no handler - should skip
      ];

      await processDiscriminatedItems(items, config, emit);

      expect(textHandler).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(0); // textHandler doesn't emit in this test
    });

    it('should handle single item (non-array)', async () => {
      const { emit, calls } = createMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: (block, emit) => emit(AgentSubjects.message, { content: block.content }),
      });

      await processDiscriminatedItems({ type: 'text', content: 'single' }, config, emit);

      expect(calls).toHaveLength(1);
      expect(calls[0].payload).toEqual({ content: 'single' });
    });
  });
});

describe('processDiscriminatedItemsSync', () => {
  describe('happy path', () => {
    it('should call handler synchronously', () => {
      const { emit, calls } = createSyncMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: (block, emit) => emit(AgentSubjects.message, { content: block.content }),
      });

      processDiscriminatedItemsSync({ type: 'text', content: 'sync' }, config, emit);

      expect(calls).toHaveLength(1);
      expect(calls[0].payload).toEqual({ content: 'sync' });
    });

    it('should process array synchronously', () => {
      const { emit, calls } = createSyncMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: (block, emit) => emit(AgentSubjects.message, { content: block.content }),
        number: (block, emit) => emit(AgentSubjects.message, { content: String(block.value) }),
      });

      const items: TestBlock[] = [
        { type: 'text', content: 'first' },
        { type: 'number', value: 42 },
      ];

      processDiscriminatedItemsSync(items, config, emit);

      expect(calls).toHaveLength(2);
    });
  });

  describe('async handler detection', () => {
    it('should throw if handler returns a Promise', () => {
      const { emit } = createSyncMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: async (block, emit) => {
          await Promise.resolve();
          emit(AgentSubjects.message, { content: block.content });
        },
      });

      expect(() => {
        processDiscriminatedItemsSync({ type: 'text', content: 'async' }, config, emit);
      }).toThrow(/returned a Promise/);
    });

    it('should include discriminator value in error message', () => {
      const { emit } = createSyncMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        number: async () => {
          await Promise.resolve();
        },
      });

      expect(() => {
        processDiscriminatedItemsSync({ type: 'number', value: 42 }, config, emit);
      }).toThrow("Handler for 'number' returned a Promise");
    });

    it('should suggest using async variant in error message', () => {
      const { emit } = createSyncMockEmit();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: async () => {
          await Promise.resolve();
        },
      });

      expect(() => {
        processDiscriminatedItemsSync({ type: 'text', content: 'test' }, config, emit);
      }).toThrow(/Use processDiscriminatedItems \(async\) instead/);
    });
  });

  describe('edge cases', () => {
    it('should be no-op for empty array', () => {
      const { emit, calls } = createSyncMockEmit();
      const handler = vi.fn();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: handler,
      });

      processDiscriminatedItemsSync([], config, emit);

      expect(handler).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    it('should skip items with unknown discriminator value', () => {
      const { emit } = createSyncMockEmit();
      const textHandler = vi.fn();

      const config = defineDiscriminatedHandlers<TestBlock>('type', {
        text: textHandler,
      });

      const items: TestBlock[] = [
        { type: 'number', value: 42 }, // no handler
        { type: 'text', content: 'handled' },
      ];

      processDiscriminatedItemsSync(items, config, emit);

      expect(textHandler).toHaveBeenCalledTimes(1);
    });
  });
});
