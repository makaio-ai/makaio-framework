import { describe, expect, it } from 'vitest';
import { WorkerProviderRegistry } from '../provider-registry.js';
import { call, processBoundProvider, providerId } from './ordered-worker-fixture.js';

describe('process-bound provider registration', () => {
  it('withdraws only the matching generation and keeps the last provider resolvable', async () => {
    const registry = new WorkerProviderRegistry();
    const activation = { owner: 'example', key: 'primary', managedScopeConfirmed: false };
    const signal = new AbortController().signal;
    const provider = processBoundProvider();
    const withdrawFirst = await registry.replace(call, { ...activation, providers: [provider] }, signal);
    const second = { ...provider, capabilities: { ...provider.capabilities, maxRuntimeMs: 2000 } };
    const withdrawSecond = await registry.replace(call, { ...activation, providers: [second] }, signal);

    withdrawFirst();
    expect(registry.selectForProvisioning(providerId)?.capabilities.maxRuntimeMs).toBe(2000);
    withdrawSecond();
    expect(registry.selectForProvisioning(providerId)).toBeUndefined();
    expect(registry.get(providerId)?.capabilities.maxRuntimeMs).toBe(2000);
  });

  it('rejects a dynamic contribution without local live proof', async () => {
    const registry = new WorkerProviderRegistry();
    const provider = processBoundProvider();
    Reflect.deleteProperty(provider, 'proveLocalLive');
    const activation = { owner: 'example', key: 'primary', managedScopeConfirmed: false, providers: [provider] };

    await expect(registry.replace(call, activation, new AbortController().signal)).rejects.toMatchObject({
      constructor: Error,
      message: 'Process-bound worker provider requires proveLocalLive()',
    });
    expect(registry.selectForProvisioning(providerId)).toBeUndefined();
  });

  it('rejects a process-bound contribution that advertises recovery', async () => {
    const registry = new WorkerProviderRegistry();
    const provider = processBoundProvider();
    const activation = { owner: 'example', key: 'primary', managedScopeConfirmed: false };
    const misleading = { ...provider, capabilities: { ...provider.capabilities, supportsRecovery: true } };
    const signal = new AbortController().signal;

    await expect(registry.replace(call, { ...activation, providers: [misleading] }, signal)).rejects.toMatchObject({
      constructor: Error,
      message: 'Process-bound worker provider cannot advertise recovery',
    });
    expect(registry.selectForProvisioning(providerId)).toBeUndefined();
    await registry.replace(call, { ...activation, providers: [provider] }, signal);
    expect(registry.selectForProvisioning(providerId)?.capabilities.supportsRecovery).toBe(false);
  });
});
