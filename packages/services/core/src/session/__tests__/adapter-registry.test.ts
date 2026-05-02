/**
 * Unit tests for AdapterRegistry.
 *
 * Verifies that `resolveAvailable()` uses the runtime resolver and that the
 * cache-only `resolve()` / `destroy()` event path behaves correctly under all
 * documented scenarios.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { AdapterRegistry } from '../adapter-registry.js';
import { resetBusHandlers } from './shared.js';

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    resetBusHandlers();
    registry = new AdapterRegistry(MakaioBus);
  });

  afterEach(() => {
    registry.destroy();
  });

  describe('resolve() before any adapter.initialized', () => {
    it('throws when no adapter has been registered', () => {
      expect(() => registry.resolve('openai-node')).toThrow('No adapter found for adapterName="openai-node"');
    });
  });

  describe('resolve() after adapter.initialized', () => {
    it('returns adapterId matching the emitted event', async () => {
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-instance-abc',
        adapterName: 'openai-node',
        capabilities: [],
      });

      expect(registry.resolve('openai-node')).toBe('adapter-instance-abc');
    });
  });

  describe('resolve() with multiple adapters', () => {
    it('resolves each adapter independently', async () => {
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-openai-1',
        adapterName: 'openai-node',
        capabilities: ['streaming'],
      });
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-claude-2',
        adapterName: 'claude-agent-sdk',
        capabilities: ['streaming', 'tools'],
      });

      expect(registry.resolve('openai-node')).toBe('adapter-openai-1');
      expect(registry.resolve('claude-agent-sdk')).toBe('adapter-claude-2');
    });

    it('resolving an unregistered name still throws when other adapters exist', async () => {
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-openai-1',
        adapterName: 'openai-node',
        capabilities: [],
      });

      expect(() => registry.resolve('unknown-adapter')).toThrow('No adapter found for adapterName="unknown-adapter"');
    });
  });

  describe('resolve() after overwrite', () => {
    it('returns the latest adapterId when the same adapterName is re-initialized', async () => {
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-instance-v1',
        adapterName: 'openai-node',
        capabilities: [],
      });
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-instance-v2',
        adapterName: 'openai-node',
        capabilities: ['streaming'],
      });

      expect(registry.resolve('openai-node')).toBe('adapter-instance-v2');
    });
  });

  describe('resolveAvailable()', () => {
    it('resolves through AdapterRuntimeSubjects.resolveId without adapter.initialized', async () => {
      const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        expect(ctx.payload.adapterName).toBe('openai-node');
        ctx.setResult({ adapterId: 'runtime-only-id' });
      });

      try {
        await expect(registry.resolveAvailable('openai-node')).resolves.toBe('runtime-only-id');
        expect(registry.resolve('openai-node')).toBe('runtime-only-id');
      } finally {
        cleanup();
      }
    });

    it('prefers the runtime resolver over the adapter.initialized event cache', async () => {
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'event-cache-id',
        adapterName: 'openai-node',
        capabilities: [],
      });

      const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        expect(ctx.payload.adapterName).toBe('openai-node');
        ctx.setResult({ adapterId: 'runtime-resolved-id' });
      });

      try {
        await expect(registry.resolveAvailable('openai-node')).resolves.toBe('runtime-resolved-id');
        expect(registry.resolve('openai-node')).toBe('runtime-resolved-id');
      } finally {
        cleanup();
      }
    });
  });

  describe('destroy()', () => {
    it('stops listening — events emitted after destroy are not registered', async () => {
      const destroyedRegistry = registry;
      registry.destroy();

      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'adapter-late',
        adapterName: 'openai-node',
        capabilities: [],
      });

      // Assert on the destroyed instance: registry was cleared and is no longer listening.
      expect(() => destroyedRegistry.resolve('openai-node')).toThrow('No adapter found for adapterName="openai-node"');

      // Recreate for afterEach safety (destroy() on an already-destroyed instance is a no-op).
      registry = new AdapterRegistry(MakaioBus);
    });
  });
});
