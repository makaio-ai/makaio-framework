import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacOSAutoLaunchProvider, resolveMacOSAutoLaunchTarget } from '../auto-launch-provider.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mkdirMock = vi.fn<(path: string, options: { recursive: boolean }) => Promise<void>>();
const writeFileMock = vi.fn<(path: string, data: string, encoding: string) => Promise<void>>();
const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
const rmMock = vi.fn<(path: string, options: { force: boolean }) => Promise<void>>();

vi.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }) => mkdirMock(path, options),
  writeFile: (path: string, data: string, encoding: string) => writeFileMock(path, data, encoding),
  readFile: (path: string, encoding: string) => readFileMock(path, encoding),
  rm: (path: string, options: { force: boolean }) => rmMock(path, options),
}));

const execFileMock =
  vi.fn<
    (
      file: string,
      args: readonly string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => void
  >();

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => execFileMock(file, args, callback),
}));

vi.mock('node:os', () => ({
  homedir: () => '/Users/testuser',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure `execFileMock` to succeed (invoke callback with no error).
 */
function execFileSucceeds(): void {
  execFileMock.mockImplementation((_file, _args, callback) => {
    callback(null, '', '');
  });
}

/**
 * Configure `execFileMock` to fail with the given message.
 * @param message - The error message for the callback.
 */
function execFileFails(message: string): void {
  execFileMock.mockImplementation((_file, _args, callback) => {
    callback(new Error(message), '', '');
  });
}

/**
 * Extract the plist content from the last `writeFile` call.
 * @returns The string content written to the plist file.
 */
function writtenPlistContent(): string {
  const calls = writeFileMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0][1];
}

const EXPECTED_PLIST_PATH = '/Users/testuser/Library/LaunchAgents/ai.makaio.app.plist';

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// resolveMacOSAutoLaunchTarget
// ---------------------------------------------------------------------------

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
    expect(
      resolveMacOSAutoLaunchTarget({
        env: {},
        execPath: '/usr/local/bin/node',
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MacOSAutoLaunchProvider
// ---------------------------------------------------------------------------

describe('MacOSAutoLaunchProvider', () => {
  const options = {
    appName: 'Custom Host',
    appPath: '/Applications/Custom Host.app',
  };

  describe('enable', () => {
    it('writes a LaunchAgent plist and loads it via launchctl', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.enable(false);

      expect(result).toEqual({ enabled: true });

      // Ensure LaunchAgents directory is created.
      expect(mkdirMock).toHaveBeenCalledWith('/Users/testuser/Library/LaunchAgents', { recursive: true });

      // Plist is written with the correct path.
      expect(writeFileMock).toHaveBeenCalledWith(
        EXPECTED_PLIST_PATH,
        expect.stringContaining('/Applications/Custom Host.app'),
        'utf-8',
      );

      // The plist should NOT contain -j flag when hidden=false.
      const writtenContent = writtenPlistContent();
      expect(writtenContent).toContain('<string>/usr/bin/open</string>');
      expect(writtenContent).toContain('<string>-a</string>');
      expect(writtenContent).not.toContain('-jga');

      // launchctl load is called.
      expect(execFileMock).toHaveBeenCalledWith('launchctl', ['load', '-w', EXPECTED_PLIST_PATH], expect.any(Function));
    });

    it('writes a plist with hidden flags when hidden=true', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider(options);
      await provider.enable(true);

      expect(writtenPlistContent()).toContain('<string>-jga</string>');
    });

    it('defaults hidden to true', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider(options);
      await provider.enable();

      expect(writtenPlistContent()).toContain('<string>-jga</string>');
    });

    it('returns an error when launchctl load fails', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      // First call: bootout (succeeds). Second call: load (fails).
      execFileMock
        .mockImplementationOnce((_file, _args, callback) => {
          callback(null, '', '');
        })
        .mockImplementationOnce((_file, _args, callback) => {
          callback(new Error('launchctl load failed'), '', '');
        });

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.enable();

      expect(result).toEqual({
        enabled: false,
        error: 'launchctl load failed',
      });
    });

    it('attempts to bootout before writing the plist', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider(options);
      await provider.enable();

      // First exec call should be bootout.
      const calls = execFileMock.mock.calls;
      expect(calls[0][0]).toBe('launchctl');
      expect(calls[0][1]).toEqual(expect.arrayContaining(['bootout']));
    });
  });

  describe('disable', () => {
    it('boots out the agent and removes the plist file', async () => {
      rmMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.disable();

      expect(result).toEqual({ disabled: true });

      // bootout is called.
      expect(execFileMock).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootout']), expect.any(Function));

      // plist is removed.
      expect(rmMock).toHaveBeenCalledWith(EXPECTED_PLIST_PATH, {
        force: true,
      });
    });

    it('succeeds even when bootout fails (agent not loaded)', async () => {
      rmMock.mockResolvedValue(undefined);
      execFileFails('Could not find specified service');

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.disable();

      expect(result).toEqual({ disabled: true });
    });

    it('returns an error when plist removal fails', async () => {
      execFileSucceeds();
      rmMock.mockRejectedValue(new Error('Permission denied'));

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.disable();

      expect(result).toEqual({
        disabled: false,
        error: 'Permission denied',
      });
    });
  });

  describe('getStatus', () => {
    it('returns enabled=true when plist exists and contains the app path', async () => {
      readFileMock.mockResolvedValue(
        `<?xml version="1.0"?><plist><dict><string>/Applications/Custom Host.app</string></dict></plist>`,
      );

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.getStatus();

      expect(result).toEqual({ enabled: true, supported: true });
      expect(readFileMock).toHaveBeenCalledWith(EXPECTED_PLIST_PATH, 'utf-8');
    });

    it('returns enabled=false when plist exists but references a different app', async () => {
      readFileMock.mockResolvedValue(
        `<?xml version="1.0"?><plist><dict><string>/Applications/Other.app</string></dict></plist>`,
      );

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.getStatus();

      expect(result).toEqual({ enabled: false, supported: true });
    });

    it('returns enabled=false when plist does not exist', async () => {
      const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      readFileMock.mockRejectedValue(enoent);

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.getStatus();

      expect(result).toEqual({ enabled: false, supported: true });
      // No error field for missing plist — it simply means auto-launch is off.
      expect(result.error).toBeUndefined();
    });

    it('returns an error for unexpected file read failures', async () => {
      readFileMock.mockRejectedValue(new Error('Unexpected read failure'));

      const provider = new MacOSAutoLaunchProvider(options);
      const result = await provider.getStatus();

      expect(result).toEqual({
        enabled: false,
        supported: true,
        error: 'Unexpected read failure',
      });
    });
  });

  describe('plist content', () => {
    it('produces valid XML with the correct label', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider(options);
      await provider.enable(false);

      const content = writtenPlistContent();
      expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(content).toContain('<string>ai.makaio.app</string>');
      expect(content).toContain('<key>RunAtLoad</key>');
      expect(content).toContain('<true/>');
    });

    it('escapes XML special characters in app path', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      execFileSucceeds();

      const provider = new MacOSAutoLaunchProvider({
        appName: 'App & <Test>',
        appPath: '/Applications/App & <Test>.app',
      });
      await provider.enable(false);

      const content = writtenPlistContent();
      expect(content).toContain('/Applications/App &amp; &lt;Test&gt;.app');
    });
  });
});
