import { describe, expect, it } from 'vitest';

const ROOT_EXPORT_TIMEOUT_MS = 20_000;

describe('@makaio/runtime-bun root entrypoint exports MergedDescriptorDiscovery', () => {
  it('exports MergedDescriptorDiscovery as a class', { timeout: ROOT_EXPORT_TIMEOUT_MS }, async () => {
    const rootModule = await import('../index.js');
    expect(rootModule.MergedDescriptorDiscovery).toBeDefined();
    expect(typeof rootModule.MergedDescriptorDiscovery).toBe('function');
  });

  it('MergedDescriptorDiscovery is the same class as the runtime-node export', {
    timeout: ROOT_EXPORT_TIMEOUT_MS,
  }, async () => {
    const bunModule = await import('../index.js');
    const { MergedDescriptorDiscovery } = await import('@makaio/runtime-node');
    expect(bunModule.MergedDescriptorDiscovery).toBe(MergedDescriptorDiscovery);
  });
});
