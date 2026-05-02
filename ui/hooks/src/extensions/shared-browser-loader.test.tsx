import type { IMakaioBus } from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadExtensionBrowserContributions } from './shared-browser-loader.js';

interface TestShellProps {
  bus: IMakaioBus;
}

interface TestContribution {
  destroy?: () => void;
  shell?: {
    component: (props: TestShellProps) => null;
  };
}

function createBus(extensions: Array<{ browser?: { entrypoint: string }; name: string; state: string }>): IMakaioBus {
  const bus: Pick<IMakaioBus, 'request'> = {
    request: vi.fn().mockResolvedValue({ extensions }),
  };

  return bus as IMakaioBus;
}

describe('loadExtensionBrowserContributions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads browser contributions and returns the resolved shell with cleanups', async () => {
    const bus = createBus([
      { browser: { entrypoint: '/extensions/alpha/browser.js' }, name: 'alpha', state: 'active' },
    ]);
    const shellComponent = vi.fn(() => null);
    const destroy = vi.fn();
    const registerCleanup = vi.fn();
    const runtimeCleanup = vi.fn();
    const unregisterFactory = vi.fn();
    const factory = vi.fn((context: { bus: IMakaioBus }) => {
      expect(context.bus).toBe(bus);
      return {
        destroy,
        shell: { component: shellComponent },
      };
    });

    const result = await loadExtensionBrowserContributions<TestContribution, TestShellProps, () => TestContribution>({
      bus,
      getRegisteredFactory: vi.fn(),
      importModule: vi.fn().mockResolvedValue({
        default: factory,
      }),
      isCurrentRun: () => true,
      registerExtensionUI: vi.fn(() => registerCleanup),
      resolveFactory: (moduleDefault) => ({
        factory: moduleDefault as (context: { bus: IMakaioBus }) => TestContribution,
        kind: 'resolved',
      }),
      unregisterFactory,
      waitForRuntimeReady: () => ({
        cleanup: runtimeCleanup,
        ready: Promise.resolve('ready'),
      }),
    });

    expect(result.state).toBe('ready');
    expect(result.errorMessage).toBeNull();
    expect(result.shell).toBe(shellComponent);

    result.cleanups.forEach((cleanup) => cleanup());
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(registerCleanup).toHaveBeenCalledTimes(1);
    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
    expect(unregisterFactory).toHaveBeenCalledWith('alpha');
  });

  it('returns an error state when the runtime does not become ready', async () => {
    const result = await loadExtensionBrowserContributions<TestContribution, TestShellProps, () => TestContribution>({
      bus: createBus([]),
      getRegisteredFactory: vi.fn(),
      isCurrentRun: () => true,
      registerExtensionUI: vi.fn(() => () => undefined),
      resolveFactory: vi.fn(),
      unregisterFactory: vi.fn(),
      waitForRuntimeReady: () => ({
        cleanup: vi.fn(),
        ready: Promise.resolve('timeout'),
      }),
    });

    expect(result.state).toBe('error');
    expect(result.errorMessage).toContain('runtime did not respond');
    expect(result.shell).toBeNull();
  });

  it('returns an error when extensions fail before any shell is provided', async () => {
    const unregisterFactory = vi.fn();
    const result = await loadExtensionBrowserContributions<TestContribution, TestShellProps, () => TestContribution>({
      bus: createBus([{ browser: { entrypoint: '/extensions/alpha/browser.js' }, name: 'alpha', state: 'active' }]),
      getRegisteredFactory: vi.fn(),
      importModule: vi.fn().mockResolvedValue({ default: 'invalid' }),
      isCurrentRun: () => true,
      registerExtensionUI: vi.fn(() => () => undefined),
      resolveFactory: () => ({
        kind: 'invalid',
        reason: 'expected callable factory',
      }),
      unregisterFactory,
      waitForRuntimeReady: () => ({
        cleanup: vi.fn(),
        ready: Promise.resolve('ready'),
      }),
    });

    expect(result.state).toBe('error');
    expect(result.errorMessage).toContain('failed to load');
    expect(result.shell).toBeNull();
    expect(unregisterFactory).toHaveBeenCalledWith('alpha');
  });

  it('skips malformed entrypoints instead of aborting the full loader', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await loadExtensionBrowserContributions<TestContribution, TestShellProps, () => TestContribution>({
      bus: createBus([{ browser: { entrypoint: 'http://[' }, name: 'alpha', state: 'active' }]),
      getRegisteredFactory: vi.fn(),
      isCurrentRun: () => true,
      registerExtensionUI: vi.fn(() => () => undefined),
      resolveFactory: vi.fn(),
      unregisterFactory: vi.fn(),
      waitForRuntimeReady: () => ({
        cleanup: vi.fn(),
        ready: Promise.resolve('ready'),
      }),
    });

    expect(result.state).toBe('error');
    expect(result.errorMessage).toContain('failed to load');
    expect(warnSpy).toHaveBeenCalledWith(
      '[ExtensionBrowserLoader] Extension "alpha" has malformed entrypoint "http://["',
    );
  });

  it('cleans up a registered factory when bundle import throws', async () => {
    const unregisterFactory = vi.fn();

    const result = await loadExtensionBrowserContributions<TestContribution, TestShellProps, () => TestContribution>({
      bus: createBus([{ browser: { entrypoint: '/extensions/alpha/browser.js' }, name: 'alpha', state: 'active' }]),
      getRegisteredFactory: vi.fn(),
      importModule: vi.fn().mockRejectedValue(new Error('boom')),
      isCurrentRun: () => true,
      registerExtensionUI: vi.fn(() => () => undefined),
      resolveFactory: vi.fn(),
      unregisterFactory,
      waitForRuntimeReady: () => ({
        cleanup: vi.fn(),
        ready: Promise.resolve('ready'),
      }),
    });

    expect(result.state).toBe('error');
    expect(unregisterFactory).toHaveBeenCalledWith('alpha');
  });
});
