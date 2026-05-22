import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { AdapterContribution } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { createAdapterSubsystemContributionProcessor } from '../adapter-subsystem-contribution-factory.js';
import type { AdapterSubsystemService } from '../adapter-subsystem-service.js';

/** Build a minimal service stub for use in factory tests. */
function createServiceStub(): Pick<
  AdapterSubsystemService,
  'processAdapterContributions' | 'stopAdapterContributions'
> {
  return {
    processAdapterContributions: vi.fn().mockResolvedValue(undefined),
    stopAdapterContributions: vi.fn().mockResolvedValue(undefined),
  };
}

const TEST_ADAPTER_CONTRIBUTION = {
  manifest: { name: 'test-adapter-pkg', protocols: ['openai'] },
  definition: {
    name: 'test-adapter-pkg',
    providers: [],
    defaultTimeouts: {
      initialization: 1,
      acknowledgement: 1,
      completion: 1,
      toolApproval: 1,
      eventWait: 1,
    },
    createAdapter: async () => ({}),
  },
} satisfies AdapterContribution;

/** Minimal extension manifest that satisfies the adapter filter. */
const PKG_WITH_ADAPTERS: KernelMakaioExtension = {
  name: 'test-adapter-pkg',
  displayName: 'Test Adapter Package',
  version: '0.1.0',
  adapters: [TEST_ADAPTER_CONTRIBUTION],
};

/** Minimal extension context stub. */
const STUB_CTX: KernelExtensionContext = {
  bus: createBusInstance(),
  identity: Object.freeze({ extensionName: 'test-adapter-pkg' }) as KernelExtensionContext['identity'],
  platform: process.platform,
  homedir: '/tmp',
  makaioHome: '/tmp/.makaio',
  dataDir: '/tmp/.makaio/test-adapter-pkg',
  username: 'test-user',
  machineId: 'test-machine',
  config: undefined,
  getService: () => undefined,
  tryImport: async () => null,
  signal: new AbortController().signal,
  hasExtension: () => false,
};

describe('createAdapterSubsystemContributionProcessor', () => {
  describe('filter', () => {
    it('returns true when the package declares adapters', () => {
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => undefined,
      });

      expect(processor.filter?.(PKG_WITH_ADAPTERS)).toBe(true);
    });

    it('returns false when the package declares no adapters', () => {
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => undefined,
      });

      const pkgWithoutAdapters: KernelMakaioExtension = {
        name: 'no-adapters',
        displayName: 'No Adapters',
        version: '0.1.0',
      };
      expect(processor.filter?.(pkgWithoutAdapters)).toBe(false);
    });

    it('returns false when the package declares an empty adapters array', () => {
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => undefined,
      });

      const pkgEmptyAdapters: KernelMakaioExtension = {
        name: 'empty-adapters',
        displayName: 'Empty Adapters',
        version: '0.1.0',
        adapters: [],
      };
      expect(processor.filter?.(pkgEmptyAdapters)).toBe(false);
    });
  });

  describe('processActivated', () => {
    it('delegates to service.processAdapterContributions', async () => {
      const service = createServiceStub();
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => service as AdapterSubsystemService,
      });

      await processor.processActivated('test-adapter-pkg', PKG_WITH_ADAPTERS, STUB_CTX);

      expect(service.processAdapterContributions).toHaveBeenCalledOnce();
      expect(service.processAdapterContributions).toHaveBeenCalledWith('test-adapter-pkg', PKG_WITH_ADAPTERS, STUB_CTX);
    });

    it('throws a hard composition error when the service is unavailable during activation', async () => {
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => undefined,
      });

      await expect(processor.processActivated('test-adapter-pkg', PKG_WITH_ADAPTERS, STUB_CTX)).rejects.toThrow(
        /AdapterSubsystemService is not available/,
      );
    });
  });

  describe('processStopped', () => {
    it('delegates to service.stopAdapterContributions', async () => {
      const service = createServiceStub();
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => service as AdapterSubsystemService,
      });

      await processor.processStopped?.('test-adapter-pkg');

      expect(service.stopAdapterContributions).toHaveBeenCalledOnce();
      expect(service.stopAdapterContributions).toHaveBeenCalledWith('test-adapter-pkg');
    });

    it('returns silently when the service is unavailable during teardown', async () => {
      const processor = createAdapterSubsystemContributionProcessor({
        getAdapterSubsystemService: () => undefined,
      });

      await expect(processor.processStopped?.('test-adapter-pkg')).resolves.toBeUndefined();
    });
  });
});
