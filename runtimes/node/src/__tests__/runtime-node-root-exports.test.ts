import { describe, expect, it } from 'vitest';

const ROOT_EXPORT_TIMEOUT_MS = 20_000;

describe('@makaio/runtime-node root entrypoint exports MergedDescriptorDiscovery', () => {
  it('exports MergedDescriptorDiscovery as a class', { timeout: ROOT_EXPORT_TIMEOUT_MS }, async () => {
    const rootModule = await import('../index.js');
    expect(rootModule.MergedDescriptorDiscovery).toBeDefined();
    expect(typeof rootModule.MergedDescriptorDiscovery).toBe('function');
  });

  it('MergedDescriptorDiscovery is the same class as the extension-discovery subpath export', {
    timeout: ROOT_EXPORT_TIMEOUT_MS,
  }, async () => {
    const rootModule = await import('../index.js');
    const subpathModule = await import('../extension-discovery.js');
    expect(rootModule.MergedDescriptorDiscovery).toBe(subpathModule.MergedDescriptorDiscovery);
  });
});
