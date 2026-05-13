/**
 * Shared behavioral test suite for MemoryStore subclasses.
 *
 * All MemoryStore implementations (ArtifactMemoryStore, TaskMemoryStore,
 * CodeReviewMemoryStore) share identical get/has/delete/isolation semantics.
 * This module defines those shared tests so each subclass only needs to
 * provide a factory and domain-specific item operations.
 */
import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Domain-specific operations for a working memory type.
 *
 * Each MemoryStore subclass holds a different kind of working memory
 * (e.g. ArtifactWorkingMemory, TaskWorkingMemory). These callbacks
 * let the shared suite create and list items without knowing the domain.
 */
export interface MemoryStoreTestOps<T> {
  /** Create a single item in the working memory instance. */
  createItem: (memory: T) => void;
  /** Return all items in the working memory instance. */
  listItems: (memory: T) => unknown[];
  /** Clear all items from the working memory instance. */
  clearItems: (memory: T) => void;
  /** Expected constructor class for `instanceof` checks. */
  memoryClass: new (...args: never[]) => T;
}

/**
 * Configuration for the shared memory store behavioral test suite.
 */
/**
 * Minimal store interface used by the shared suite.
 *
 * Compatible with `MemoryStore<T, []>` and `MemoryStore<T, [optional?]>`
 * since the suite only calls `get(sessionId)` with no extra args.
 */
export interface MemoryStoreLike<T> {
  get(sessionId: string): T;
  has(sessionId: string): boolean;
  delete(sessionId: string): boolean;
}

/**
 * Configuration for the shared memory store behavioral test suite.
 */
export interface MemoryStoreBehaviorConfig<T> {
  /** Human-readable name for the describe block (e.g. 'ArtifactMemoryStore'). */
  name: string;
  /** Factory to create a fresh store instance per test. */
  createStore: () => MemoryStoreLike<T>;
  /** Domain-specific item operations. */
  ops: MemoryStoreTestOps<T>;
}

/**
 * Registers shared behavioral tests for any MemoryStore subclass.
 *
 * Call this at the top level of a test file. It creates its own
 * `describe` block with the provided name.
 * @param config - Test suite configuration
 */
export function describeMemoryStoreBehavior<T>(config: MemoryStoreBehaviorConfig<T>): void {
  const { name, createStore, ops } = config;

  describe(name, () => {
    let store: MemoryStoreLike<T>;

    beforeEach(() => {
      store = createStore();
    });

    describe('get', () => {
      it('should create new working memory for unknown session', () => {
        const memory = store.get('session-1');
        expect(memory).toBeInstanceOf(ops.memoryClass);
      });

      it('should return the same instance for the same session', () => {
        const memory1 = store.get('session-1');
        const memory2 = store.get('session-1');
        expect(memory1).toBe(memory2);
      });

      it('should return different instances for different sessions', () => {
        const memory1 = store.get('session-1');
        const memory2 = store.get('session-2');
        expect(memory1).not.toBe(memory2);
      });

      it('should preserve state across multiple get calls', () => {
        const memory1 = store.get('session-1');
        ops.createItem(memory1);

        const memory2 = store.get('session-1');
        const items = ops.listItems(memory2);
        expect(items).toHaveLength(1);
      });
    });

    describe('has', () => {
      it('should return false for unknown session', () => {
        expect(store.has('nonexistent')).toBe(false);
      });

      it('should return true for known session', () => {
        store.get('session-1');
        expect(store.has('session-1')).toBe(true);
      });

      it('should return false for different session', () => {
        store.get('session-1');
        expect(store.has('session-2')).toBe(false);
      });
    });

    describe('delete', () => {
      it('should remove session memory', () => {
        store.get('session-1');
        const result = store.delete('session-1');
        expect(result).toBe(true);
        expect(store.has('session-1')).toBe(false);
      });

      it('should return false for unknown session', () => {
        const result = store.delete('nonexistent');
        expect(result).toBe(false);
      });

      it('should clear items when deleted and recreated', () => {
        const memory1 = store.get('session-1');
        ops.createItem(memory1);
        store.delete('session-1');
        const memory2 = store.get('session-1');
        expect(ops.listItems(memory2)).toHaveLength(0);
        expect(memory2).not.toBe(memory1);
      });

      it('should not affect other sessions', () => {
        const memory1 = store.get('session-1');
        ops.createItem(memory1);
        const memory2 = store.get('session-2');
        ops.createItem(memory2);
        store.delete('session-1');
        expect(store.has('session-2')).toBe(true);
        expect(ops.listItems(store.get('session-2'))).toHaveLength(1);
      });
    });

    describe('isolation', () => {
      it('should isolate items between sessions', () => {
        const memory1 = store.get('session-1');
        const memory2 = store.get('session-2');
        ops.createItem(memory1);
        ops.createItem(memory1);
        ops.createItem(memory2);
        expect(ops.listItems(memory1)).toHaveLength(2);
        expect(ops.listItems(memory2)).toHaveLength(1);
        ops.clearItems(memory1);
        expect(ops.listItems(memory1)).toHaveLength(0);
        expect(ops.listItems(memory2)).toHaveLength(1);
      });
    });
  });
}
