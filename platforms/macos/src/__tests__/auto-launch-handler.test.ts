/**
 * Unit tests for {@link registerAutoLaunchHandlers}.
 *
 * Verifies that the handler wiring layer correctly bridges
 * `platform.autoLaunch.*` bus subjects to an `IAutoLaunchProvider` instance.
 *
 * The bus under test is an isolated in-process instance — no transports,
 * no global singleton state. Provider methods are vitest fakes that return
 * controlled responses so we can assert both the call site (correct arguments)
 * and the result forwarded back through the bus.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBusInstance, createBusContext, NoHandlerError } from '@makaio/bus-core';
import { PlatformSubjects } from '@makaio/contracts';
import type { IAutoLaunchProvider } from '@makaio/contracts';
import { registerAutoLaunchHandlers } from '../auto-launch-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fully-typed `IAutoLaunchProvider` test double.
 * @param overrides - Partial overrides applied on top of the defaults.
 * @returns A vitest-backed provider stub.
 */
function createMockProvider(overrides: Partial<IAutoLaunchProvider> = {}): IAutoLaunchProvider {
  return {
    id: 'test-auto-launch',
    displayName: 'Test Auto Launch',
    capabilityId: 'autoLaunch',
    enable: vi.fn().mockResolvedValue({ enabled: true }),
    disable: vi.fn().mockResolvedValue({ disabled: true }),
    getStatus: vi.fn().mockResolvedValue({ enabled: false, supported: true }),
    ...overrides,
  };
}

/**
 * Create an isolated bus instance for a single test.
 *
 * Using an explicit fresh context keeps tests hermetic — no shared handler
 * state from the `MakaioBus` singleton, and no need for `__resetHandlers`.
 */
function createTestBus() {
  return createBusInstance({ context: createBusContext() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerAutoLaunchHandlers', () => {
  it('routes autoLaunch.enable to provider.enable()', async () => {
    const bus = createTestBus();
    const provider = createMockProvider();
    const cleanup = registerAutoLaunchHandlers(bus, provider);

    try {
      const result = await bus.request(PlatformSubjects.autoLaunch.enable, {
        hidden: true,
      });

      expect(result.enabled).toBe(true);
      expect(provider.enable).toHaveBeenCalledWith(true);
    } finally {
      cleanup();
    }
  });

  it('routes autoLaunch.enable with hidden=false to provider.enable(false)', async () => {
    const bus = createTestBus();
    const provider = createMockProvider({
      enable: vi.fn().mockResolvedValue({ enabled: true }),
    });
    const cleanup = registerAutoLaunchHandlers(bus, provider);

    try {
      await bus.request(PlatformSubjects.autoLaunch.enable, { hidden: false });

      expect(provider.enable).toHaveBeenCalledWith(false);
    } finally {
      cleanup();
    }
  });

  it('routes autoLaunch.disable to provider.disable()', async () => {
    const bus = createTestBus();
    const provider = createMockProvider();
    const cleanup = registerAutoLaunchHandlers(bus, provider);

    try {
      const result = await bus.request(PlatformSubjects.autoLaunch.disable, {});

      expect(result.disabled).toBe(true);
      expect(provider.disable).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('routes autoLaunch.getStatus to provider.getStatus()', async () => {
    const bus = createTestBus();
    const provider = createMockProvider();
    const cleanup = registerAutoLaunchHandlers(bus, provider);

    try {
      const result = await bus.request(PlatformSubjects.autoLaunch.getStatus, {});

      expect(result).toEqual({ enabled: false, supported: true });
      expect(provider.getStatus).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('forwards a provider error response to the bus caller', async () => {
    const bus = createTestBus();
    const provider = createMockProvider({
      enable: vi.fn().mockResolvedValue({ enabled: false, error: 'permission denied' }),
    });
    const cleanup = registerAutoLaunchHandlers(bus, provider);

    try {
      const result = await bus.request(PlatformSubjects.autoLaunch.enable, {});

      expect(result.enabled).toBe(false);
      expect(result.error).toBe('permission denied');
    } finally {
      cleanup();
    }
  });

  it('cleanup unregisters all handlers', async () => {
    const bus = createTestBus();
    const provider = createMockProvider();
    const cleanup = registerAutoLaunchHandlers(bus, provider);
    cleanup();

    await expect(bus.request(PlatformSubjects.autoLaunch.getStatus, {})).rejects.toThrow(NoHandlerError);
  });

  it('cleanup unregisters enable and disable handlers too', async () => {
    const bus = createTestBus();
    const provider = createMockProvider();
    const cleanup = registerAutoLaunchHandlers(bus, provider);
    cleanup();

    await expect(bus.request(PlatformSubjects.autoLaunch.enable, { hidden: true })).rejects.toThrow(NoHandlerError);

    await expect(bus.request(PlatformSubjects.autoLaunch.disable, {})).rejects.toThrow(NoHandlerError);
  });
});
