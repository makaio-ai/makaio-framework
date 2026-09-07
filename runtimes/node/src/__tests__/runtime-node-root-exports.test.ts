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

describe('@makaio/runtime-node outcome error exports', () => {
  it('exposes the actual generic delivery error through root and worker entrypoints', {
    timeout: ROOT_EXPORT_TIMEOUT_MS,
  }, async () => {
    const rootModule = await import('../index.js');
    const workerModule = await import('../workflow-worker/index.js');
    const implementation = await import('../workflow-worker/outcome-submission.js');

    expect(rootModule.AuthorityRequestDeliveryError).toBe(implementation.AuthorityRequestDeliveryError);
    expect(workerModule.AuthorityRequestDeliveryError).toBe(implementation.AuthorityRequestDeliveryError);
    expect(rootModule.AttemptOutcomeDeliveryError).toBe(implementation.AttemptOutcomeDeliveryError);
    expect(workerModule.AttemptOutcomeDeliveryError).toBe(implementation.AttemptOutcomeDeliveryError);
    expect(rootModule.OutcomeDeliveryError).toBe(implementation.OutcomeDeliveryError);
    expect(rootModule.AttemptOutcomeDeliveryError).not.toBe(rootModule.OutcomeDeliveryError);
    expect(rootModule.AuthorityRequestDeliveryError).not.toBe(rootModule.AttemptOutcomeDeliveryError);
    expect(rootModule.AuthorityRequestDeliveryError).not.toBe(rootModule.OutcomeDeliveryError);
    expect(rootModule).not.toHaveProperty('retryAuthorityRequest');
    expect(workerModule).not.toHaveProperty('retryAuthorityRequest');
    expect(rootModule).not.toHaveProperty('requestAuthorityWithRetry');
    expect(workerModule).not.toHaveProperty('requestAuthorityWithRetry');
  });
});
