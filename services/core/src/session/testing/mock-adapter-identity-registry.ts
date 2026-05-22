import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterIdentityRegistry } from '../../adapter-runtime/identity.js';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';

export const DEFAULT_TEST_MACHINE_ID = 'test-machine';

/**
 * Mock adapter identity registry for session tests.
 * Keeps reverse lookup strict while allowing deterministic adapter ID resolution.
 */
export interface MockAdapterIdentityRegistry {
  registerHandlers: () => () => void;
  registerKnownAdapter: (adapterName: string, adapterId?: string) => Promise<void>;
}

/**
 * Create a mock adapter identity registry shared by session test helpers.
 * @param currentMachineId - Optional runtime-default machine for resolveId
 * @returns Registry wrapper with registration helpers and bus handler setup
 */
export function createMockAdapterIdentityRegistry(currentMachineId?: string): MockAdapterIdentityRegistry {
  const registry = new AdapterIdentityRegistry(currentMachineId);

  return {
    registerHandlers(): () => void {
      const unsubs = [
        MakaioBus.on(AdapterSubjects.initialized, (context) => {
          registry.rememberAdapterId(context.payload.adapterId, context.payload.adapterName);
        }),
        MakaioBus.on(AdapterRuntimeSubjects.resolveId, (context) => {
          const adapterId = registry.resolveId(context.payload);
          context.setResult({ adapterId });
        }),
        MakaioBus.on(AdapterRuntimeSubjects.resolveName, (context) => {
          const adapterName = registry.resolveAdapterName(context.payload.adapterId);
          if (!adapterName) {
            throw new Error(`Adapter not found for adapterId="${context.payload.adapterId}"`);
          }
          context.setResult({ adapterName });
        }),
      ];

      return () => {
        for (const unsub of unsubs) {
          unsub();
        }
      };
    },

    async registerKnownAdapter(adapterName: string, adapterId?: string): Promise<void> {
      const resolvedAdapterId = adapterId ?? registry.resolveId({ adapterName });
      await MakaioBus.emit(AdapterSubjects.initialized, {
        adapterName,
        adapterId: resolvedAdapterId,
        capabilities: [],
      });
    },
  };
}

/**
 * Register the shared mock adapter identity handlers for session tests.
 * @param currentMachineId - Optional runtime-default machine for resolveId
 * @returns Registry and cleanup for the registered mock handlers
 */
export function registerMockAdapterIdentityHandlers(currentMachineId?: string): {
  registry: MockAdapterIdentityRegistry;
  unsubscribe: () => void;
} {
  const registry = createMockAdapterIdentityRegistry(currentMachineId);
  return {
    registry,
    unsubscribe: registry.registerHandlers(),
  };
}
