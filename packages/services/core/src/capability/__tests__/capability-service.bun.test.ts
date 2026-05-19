import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects, type ICapabilityProvider } from '@makaio/contracts';
import { CapabilityService } from '@makaio/services-core/capability';

/**
 * Minimal provider factory for test fixtures.
 * @param overrides - Optional overrides for the default provider fields
 * @returns A minimal ICapabilityProvider implementation
 */
function makeProvider(overrides: Partial<ICapabilityProvider> = {}): ICapabilityProvider {
  return {
    id: 'provider-1',
    displayName: 'Test Provider',
    ...overrides,
  };
}

describe('CapabilityService', () => {
  let bus: IMakaioBus;
  let service: CapabilityService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new CapabilityService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  describe('provider registration via bus emit', () => {
    it('registers a provider and makes it retrievable via getProviders', async () => {
      const provider = makeProvider({ id: 'p1', displayName: 'Provider One' });

      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'test-capability',
        provider,
      });

      const providers = service.getProviders('test-capability');
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('p1');
      expect(providers[0].displayName).toBe('Provider One');
    });

    it('registers providers under independent capability buckets', async () => {
      const providerA = makeProvider({ id: 'a', displayName: 'A' });
      const providerB = makeProvider({ id: 'b', displayName: 'B' });

      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'capability-x',
        provider: providerA,
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'capability-y',
        provider: providerB,
      });

      expect(service.getProviders('capability-x')).toHaveLength(1);
      expect(service.getProviders('capability-y')).toHaveLength(1);
      expect(service.getProviders('capability-x')[0].id).toBe('a');
      expect(service.getProviders('capability-y')[0].id).toBe('b');
    });

    it('registers multiple distinct providers for the same capability', async () => {
      const p1 = makeProvider({ id: 'p1', displayName: 'One' });
      const p2 = makeProvider({ id: 'p2', displayName: 'Two' });

      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'multi',
        provider: p1,
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'multi',
        provider: p2,
      });

      expect(service.getProviders('multi')).toHaveLength(2);
    });
  });

  describe('duplicate registration handling', () => {
    it('replaces an existing registration with the same provider id', async () => {
      const provider = makeProvider({ id: 'dup', displayName: 'Original' });
      const duplicate = makeProvider({ id: 'dup', displayName: 'Duplicate' });

      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'dedup-cap',
        provider,
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'dedup-cap',
        provider: duplicate,
      });

      const providers = service.getProviders('dedup-cap');
      expect(providers).toHaveLength(1);
      expect(providers[0].displayName).toBe('Duplicate');
    });
  });

  describe('provider unregistration via bus emit', () => {
    it('removes a provider and keeps the remaining providers in the capability bucket', async () => {
      const p1 = makeProvider({ id: 'p1', displayName: 'One' });
      const p2 = makeProvider({ id: 'p2', displayName: 'Two' });

      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'multi',
        provider: p1,
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'multi',
        provider: p2,
      });

      await bus.emit(CapabilitySubjects.unregister, {
        capabilityId: 'multi',
        providerId: 'p1',
      });

      const providers = service.getProviders('multi');
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('p2');
    });

    it('removes the capability bucket when its last provider is unregistered', async () => {
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'single',
        provider: makeProvider({ id: 'only' }),
      });

      await bus.emit(CapabilitySubjects.unregister, {
        capabilityId: 'single',
        providerId: 'only',
      });

      expect(service.getProviders('single')).toHaveLength(0);
      expect(service.hasProviders('single')).toBe(false);
      expect(service.getCapabilities()).not.toContain('single');
    });
  });

  describe('listProviders via bus request', () => {
    it('returns an empty array for an unknown capability', async () => {
      const result = await bus.request(CapabilitySubjects.listProviders, {
        capabilityId: 'unknown-cap',
      });

      expect(result.providers).toEqual([]);
    });

    it('returns registered provider summaries for a known capability', async () => {
      const provider = makeProvider({
        id: 'p1',
        displayName: 'My Provider',
        providerKey: 'my-key',
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'vcs',
        provider,
      });

      const result = await bus.request(CapabilitySubjects.listProviders, {
        capabilityId: 'vcs',
      });

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0]).toEqual({
        id: 'p1',
        displayName: 'My Provider',
        providerKey: 'my-key',
      });
    });

    it('omits providerKey from summary when not set on the provider', async () => {
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'no-key-cap',
        provider: makeProvider({ id: 'pk-less', displayName: 'No Key' }),
      });

      const result = await bus.request(CapabilitySubjects.listProviders, {
        capabilityId: 'no-key-cap',
      });

      expect(result.providers[0].providerKey).toBeUndefined();
    });
  });

  describe('validate via bus request', () => {
    it('returns valid:true for a provider without a validate method', async () => {
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'val-cap',
        provider: makeProvider({ id: 'no-validate' }),
      });

      const result = await bus.request(CapabilitySubjects.validate, {
        capabilityId: 'val-cap',
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({ id: 'no-validate', valid: true });
    });

    it('returns the result from a provider validate() method on success', async () => {
      const provider: ICapabilityProvider = {
        id: 'validates-ok',
        displayName: 'Validates OK',
        validate: async () => ({ valid: true }),
      };
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'val-cap',
        provider,
      });

      const result = await bus.request(CapabilitySubjects.validate, {
        capabilityId: 'val-cap',
      });

      expect(result.results[0]).toEqual({ id: 'validates-ok', valid: true });
    });

    it('surfaces the error message when a provider validate() method fails', async () => {
      const provider: ICapabilityProvider = {
        id: 'validates-fail',
        displayName: 'Validates Fail',
        validate: async () => ({
          valid: false,
          error: 'Credentials missing',
        }),
      };
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'val-fail-cap',
        provider,
      });

      const result = await bus.request(CapabilitySubjects.validate, {
        capabilityId: 'val-fail-cap',
      });

      expect(result.results[0]).toEqual({
        id: 'validates-fail',
        valid: false,
        error: 'Credentials missing',
      });
    });

    it('validates multiple providers and returns results for each', async () => {
      const pass: ICapabilityProvider = {
        id: 'pass',
        displayName: 'Pass',
        validate: async () => ({ valid: true }),
      };
      const fail: ICapabilityProvider = {
        id: 'fail',
        displayName: 'Fail',
        validate: async () => ({ valid: false, error: 'bad config' }),
      };

      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'mixed-cap',
        provider: pass,
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'mixed-cap',
        provider: fail,
      });

      const result = await bus.request(CapabilitySubjects.validate, {
        capabilityId: 'mixed-cap',
      });

      expect(result.results).toHaveLength(2);
      const byId = Object.fromEntries(result.results.map((r) => [r.id, r]));
      expect(byId['pass'].valid).toBe(true);
      expect(byId['fail'].valid).toBe(false);
      expect(byId['fail'].error).toBe('bad config');
    });

    it('returns empty results array for an unknown capability', async () => {
      const result = await bus.request(CapabilitySubjects.validate, {
        capabilityId: 'empty-cap',
      });

      expect(result.results).toEqual([]);
    });
  });

  describe('direct API surface', () => {
    it('hasProviders returns false when no providers are registered', () => {
      expect(service.hasProviders('none')).toBe(false);
    });

    it('hasProviders returns true after at least one provider is registered', async () => {
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'has-cap',
        provider: makeProvider({ id: 'x' }),
      });

      expect(service.hasProviders('has-cap')).toBe(true);
    });

    it('getCapabilities returns the distinct capability ids that have providers', async () => {
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'cap-a',
        provider: makeProvider({ id: 'a' }),
      });
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'cap-b',
        provider: makeProvider({ id: 'b' }),
      });

      const caps = service.getCapabilities();
      expect(caps).toContain('cap-a');
      expect(caps).toContain('cap-b');
    });

    it('clear() removes all providers from all capabilities', async () => {
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: 'clear-cap',
        provider: makeProvider({ id: 'c1' }),
      });

      service.clear();

      expect(service.getProviders('clear-cap')).toHaveLength(0);
      expect(service.hasProviders('clear-cap')).toBe(false);
      expect(service.getCapabilities()).toHaveLength(0);
    });
  });
});
