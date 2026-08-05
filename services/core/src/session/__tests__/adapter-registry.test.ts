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

    it('never serves one machine\u2019s instance to a lookup that named another', async () => {
      // An instance ID is derived from `(machineId, adapterName)`, so caching by
      // name alone lets a fallback hand out the instance of a machine the caller
      // never asked about — the caller then dispatches to machine R while
      // claiming ownership in machine X's namespace, which is the mixed key the
      // ownership seam exists to refuse.
      let resolvable = true;
      const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        if (!resolvable) throw new Error('adapter runtime identity is unavailable');
        ctx.setResult({ adapterId: `instance-for-${ctx.payload.machineId ?? 'own'}` });
      });

      try {
        await expect(registry.resolveAvailable('openai-node', 'machine-a')).resolves.toBe('instance-for-machine-a');
        await expect(registry.resolveAvailable('openai-node', 'machine-b')).resolves.toBe('instance-for-machine-b');

        resolvable = false;
        // Each scope falls back to what *it* resolved, and to nothing else.
        await expect(registry.resolveAvailable('openai-node', 'machine-a')).resolves.toBe('instance-for-machine-a');
        await expect(registry.resolveAvailable('openai-node', 'machine-b')).resolves.toBe('instance-for-machine-b');
        // A machine neither call resolved for has no cached answer, and the
        // failure names the scope that came up empty rather than guessing.
        await expect(registry.resolveAvailable('openai-node', 'machine-c')).rejects.toThrow('machineId="machine-c"');
      } finally {
        cleanup();
      }
    });

    it('does not answer a machine-scoped lookup from the unattributed event cache', async () => {
      // `adapter.initialized` carries no machine, and the bus can span hosts, so
      // the instance it announces belongs to nobody in particular. It may serve
      // the unscoped lookup it always served; a caller careful enough to name a
      // machine gets a failure instead of a guess about that very identity.
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterId: 'unattributed-id',
        adapterName: 'openai-node',
        capabilities: [],
      });
      const cleanup = MakaioBus.on(AdapterRuntimeSubjects.resolveId, () => {
        throw new Error('adapter runtime identity is unavailable');
      });

      try {
        await expect(registry.resolveAvailable('openai-node', 'machine-a')).rejects.toThrow('machineId="machine-a"');
        await expect(registry.resolveAvailable('openai-node')).resolves.toBe('unattributed-id');
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
