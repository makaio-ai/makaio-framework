import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createElectronForegroundRequestController } from '../src/main/foreground-requests.js';

function createControllerHarness() {
  let ready = false;
  let hasOpenWindows = false;

  const restoreFromBackgroundMode = vi.fn<() => void>();
  const focusWindow = vi.fn<() => boolean>(() => true);
  const openDefaultWindow = vi.fn<() => void>();

  const controller = createElectronForegroundRequestController({
    isReady: () => ready,
    hasOpenWindows: () => hasOpenWindows,
    focusWindow,
    openDefaultWindow,
    restoreFromBackgroundMode,
  });

  return {
    controller,
    focusWindow,
    openDefaultWindow,
    restoreFromBackgroundMode,
    setHasOpenWindows(value: boolean): void {
      hasOpenWindows = value;
    },
    setReady(value: boolean): void {
      ready = value;
    },
  };
}

describe('createElectronForegroundRequestController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues second-instance foreground requests until startup is ready', () => {
    const harness = createControllerHarness();

    harness.controller.request('second-instance');

    expect(harness.restoreFromBackgroundMode).toHaveBeenCalledOnce();
    expect(harness.focusWindow).not.toHaveBeenCalled();
    expect(harness.openDefaultWindow).not.toHaveBeenCalled();

    harness.setReady(true);
    harness.controller.flush();

    expect(harness.focusWindow).toHaveBeenCalledOnce();
    expect(harness.openDefaultWindow).not.toHaveBeenCalled();
  });

  it('opens the default window for second-instance when no existing window can be focused', () => {
    const harness = createControllerHarness();
    harness.focusWindow.mockReturnValue(false);
    harness.setReady(true);

    harness.controller.request('second-instance');

    expect(harness.focusWindow).toHaveBeenCalledOnce();
    expect(harness.openDefaultWindow).toHaveBeenCalledOnce();
  });

  it('preserves activate behavior by opening only when no native windows exist', () => {
    const harness = createControllerHarness();
    harness.setReady(true);
    harness.setHasOpenWindows(true);

    harness.controller.request('activate');

    expect(harness.openDefaultWindow).not.toHaveBeenCalled();

    harness.setHasOpenWindows(false);
    harness.controller.request('activate');

    expect(harness.openDefaultWindow).toHaveBeenCalledOnce();
    expect(harness.focusWindow).not.toHaveBeenCalled();
  });

  it('replays a queued activate request after startup without duplicating restored windows', () => {
    const harness = createControllerHarness();

    harness.controller.request('activate');
    harness.setHasOpenWindows(true);
    harness.setReady(true);
    harness.controller.flush();

    expect(harness.openDefaultWindow).not.toHaveBeenCalled();
    expect(harness.focusWindow).not.toHaveBeenCalled();
  });

  it('lets a pending second-instance request supersede a pending activate request', () => {
    const harness = createControllerHarness();

    harness.controller.request('activate');
    harness.controller.request('second-instance');

    harness.setReady(true);
    harness.controller.flush();

    expect(harness.focusWindow).toHaveBeenCalledOnce();
    expect(harness.openDefaultWindow).not.toHaveBeenCalled();
  });
});
