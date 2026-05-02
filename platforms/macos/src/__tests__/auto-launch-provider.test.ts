import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacOSAutoLaunchProvider, resolveMacOSAutoLaunchTarget } from '../auto-launch-provider.js';

const { runAppleScriptMock } = vi.hoisted(() => ({
  runAppleScriptMock: vi.fn<(script: string) => Promise<string>>(),
}));

vi.mock('run-applescript', () => ({
  runAppleScript: runAppleScriptMock,
}));

afterEach(() => {
  runAppleScriptMock.mockReset();
});

describe('resolveMacOSAutoLaunchTarget', () => {
  it('uses MAKAIO_APP as explicit host policy and derives the Login Item name from it', () => {
    const target = resolveMacOSAutoLaunchTarget({
      env: { MAKAIO_APP: '/Applications/Custom Host.app' },
      execPath: '/usr/local/bin/node',
    });

    expect(target).toEqual({
      appName: 'Custom Host',
      appPath: '/Applications/Custom Host.app',
    });
  });

  it('derives the target from the running app bundle when no explicit path exists', () => {
    const target = resolveMacOSAutoLaunchTarget({
      env: {},
      execPath: '/Applications/Makaio Dev.app/Contents/MacOS/bun',
    });

    expect(target).toEqual({
      appName: 'Makaio Dev',
      appPath: '/Applications/Makaio Dev.app',
    });
  });

  it('returns undefined for headless processes outside a macOS app bundle', () => {
    expect(resolveMacOSAutoLaunchTarget({ env: {}, execPath: '/usr/local/bin/node' })).toBeUndefined();
  });
});

describe('MacOSAutoLaunchProvider', () => {
  it('uses a consistent target path for enable and Login Item name for disable/status', async () => {
    runAppleScriptMock.mockResolvedValue('Custom Host, Other Item');
    const provider = new MacOSAutoLaunchProvider({
      appName: 'Custom Host',
      appPath: '/Applications/Custom Host.app',
    });

    await expect(provider.enable(false)).resolves.toEqual({ enabled: true });
    await expect(provider.disable()).resolves.toEqual({ disabled: true });
    await expect(provider.getStatus()).resolves.toEqual({ enabled: true, supported: true });

    expect(runAppleScriptMock).toHaveBeenNthCalledWith(
      1,
      'tell application "System Events" to make login item at end with properties {path:"/Applications/Custom Host.app", hidden:false}',
    );
    expect(runAppleScriptMock).toHaveBeenNthCalledWith(
      2,
      'tell application "System Events" to delete login item "Custom Host"',
    );
    expect(runAppleScriptMock).toHaveBeenCalledTimes(3);
    expect(runAppleScriptMock).toHaveBeenNthCalledWith(
      3,
      'tell application "System Events" to get the name of every login item',
    );
  });

  it('returns the status lookup error when Login Item inspection fails', async () => {
    runAppleScriptMock.mockRejectedValue(new Error('System Events denied access'));
    const provider = new MacOSAutoLaunchProvider({
      appName: 'Custom Host',
      appPath: '/Applications/Custom Host.app',
    });

    await expect(provider.getStatus()).resolves.toEqual({
      enabled: false,
      supported: true,
      error: 'System Events denied access',
    });
  });
});
