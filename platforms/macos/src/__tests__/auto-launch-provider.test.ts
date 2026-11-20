import type { LaunchResult, LaunchStatus } from '@makaio/subprocess';
import { recordingLaunch } from '@makaio/subprocess/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacOSAutoLaunchProvider, resolveMacOSAutoLaunchTarget } from '../auto-launch-provider.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mkdirMock = vi.fn<(path: string, options: { recursive: boolean }) => Promise<void>>();
const writeFileMock = vi.fn<(path: string, data: string, encoding: string) => Promise<void>>();
const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>();
const rmMock = vi.fn<(path: string, options: { force: boolean }) => Promise<void>>();
const TEST_HOME = '/tmp/makaio-test-home';

vi.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }) => mkdirMock(path, options),
  writeFile: (path: string, data: string, encoding: string) => writeFileMock(path, data, encoding),
  readFile: (path: string, encoding: string) => readFileMock(path, encoding),
  rm: (path: string, options: { force: boolean }) => rmMock(path, options),
}));

vi.mock('node:os', () => ({
  homedir: () => TEST_HOME,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPLETED: LaunchResult = { status: 'completed' };

/** A completed `launchctl load`: it runs with captured output, so a real completed run carries it. */
const LOADED: LaunchResult = { status: 'completed', output: { stdout: '', stderr: '' } };

/** The bounds both `launchctl` calls must carry. */
const EXPECTED_BOUNDS = {
  command: 'launchctl',
  cwd: process.cwd(),
  envMode: 'merge',
  timeoutMs: 10_000,
} as const;

/** The argument of `bootout`, as the provider derives it from the running user. */
const EXPECTED_BOOTOUT_ARGS = ['bootout', `gui/${String(process.getuid?.() ?? 501)}/ai.makaio.app`];

/**
 * Extract the plist content from the last `writeFile` call.
 * @returns The string content written to the plist file.
 */
function writtenPlistContent(): string {
  const calls = writeFileMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0][1];
}

const EXPECTED_PLIST_PATH = `${TEST_HOME}/Library/LaunchAgents/ai.makaio.app.plist`;

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
      const port = recordingLaunch(COMPLETED, LOADED);

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      const result = await provider.enable(false);

      expect(result).toEqual({ enabled: true });

      // Ensure LaunchAgents directory is created.
      expect(mkdirMock).toHaveBeenCalledWith(`${TEST_HOME}/Library/LaunchAgents`, { recursive: true });

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

      // bootout first (output discarded), then load (output captured, 64 KiB).
      expect(port.calls).toEqual([
        { ...EXPECTED_BOUNDS, args: EXPECTED_BOOTOUT_ARGS, output: { kind: 'ignore' } },
        {
          ...EXPECTED_BOUNDS,
          args: ['load', '-w', EXPECTED_PLIST_PATH],
          output: { kind: 'capture', limitBytes: 64 * 1024 },
        },
      ]);
    });

    it('writes a plist with hidden flags when hidden=true', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: recordingLaunch().launch });
      await provider.enable(true);

      expect(writtenPlistContent()).toContain('<string>-jga</string>');
    });

    it('defaults hidden to true', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: recordingLaunch().launch });
      await provider.enable();

      expect(writtenPlistContent()).toContain('<string>-jga</string>');
    });

    it.each<LaunchStatus>([
      'failed',
      'cancelled',
      'timed-out',
      'output-limit',
      'spawn-failed',
      'stop-failed',
    ])('returns an error naming the status when launchctl load ends %s', async (status) => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      // First call: bootout (completes). Second call: load (does not complete).
      const port = recordingLaunch(COMPLETED, { status });

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      const result = await provider.enable();

      expect(result).toEqual({ enabled: false, error: `launchctl load failed (${status})` });
    });

    it('appends the trimmed stderr of launchctl load to the error', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      const port = recordingLaunch(COMPLETED, {
        status: 'failed',
        output: { stdout: '', stderr: 'Load failed: 5: Input/output error\n' },
      });

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      const result = await provider.enable();

      expect(result).toEqual({
        enabled: false,
        error: 'launchctl load failed (failed): Load failed: 5: Input/output error',
      });
    });

    it('ignores the outcome of bootout and still loads the agent', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      const port = recordingLaunch({ status: 'failed' }, LOADED);

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      const result = await provider.enable();

      expect(result).toEqual({ enabled: true });
      expect(port.calls.map((call) => call.args?.[0])).toEqual(['bootout', 'load']);
    });

    it('attempts to bootout before writing the plist', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockImplementation(() => {
        // The bootout call must already be recorded when the plist is written.
        expect(port.calls.map((call) => call.args?.[0])).toEqual(['bootout']);
        return Promise.resolve();
      });
      const port = recordingLaunch();

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      await provider.enable();

      expect(writeFileMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('disable', () => {
    it('boots out the agent and removes the plist file', async () => {
      rmMock.mockResolvedValue(undefined);
      const port = recordingLaunch();

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      const result = await provider.disable();

      expect(result).toEqual({ disabled: true });

      // bootout is the only launchctl call.
      expect(port.calls).toEqual([{ ...EXPECTED_BOUNDS, args: EXPECTED_BOOTOUT_ARGS, output: { kind: 'ignore' } }]);

      // plist is removed.
      expect(rmMock).toHaveBeenCalledWith(EXPECTED_PLIST_PATH, {
        force: true,
      });
    });

    it('succeeds even when bootout fails (agent not loaded)', async () => {
      rmMock.mockResolvedValue(undefined);
      const port = recordingLaunch({ status: 'failed' });

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: port.launch });
      const result = await provider.disable();

      expect(result).toEqual({ disabled: true });
    });

    it('returns an error when plist removal fails', async () => {
      rmMock.mockRejectedValue(new Error('Permission denied'));

      const provider = new MacOSAutoLaunchProvider({ ...options, launch: recordingLaunch().launch });
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

    it('returns enabled=true after enable() with special characters in path', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      const provider = new MacOSAutoLaunchProvider({
        appName: 'App & <Test>',
        appPath: '/Applications/App & <Test>.app',
        launch: recordingLaunch().launch,
      });
      await provider.enable(false);

      readFileMock.mockResolvedValue(writtenPlistContent());

      const status = await provider.getStatus();
      expect(status).toEqual({ enabled: true, supported: true });
    });
  });

  describe('plist content', () => {
    it('produces valid XML with the correct label', async () => {
      mkdirMock.mockResolvedValue(undefined);
      writeFileMock.mockResolvedValue(undefined);
      const provider = new MacOSAutoLaunchProvider({ ...options, launch: recordingLaunch().launch });
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
      const provider = new MacOSAutoLaunchProvider({
        appName: 'App & <Test>',
        appPath: '/Applications/App & <Test>.app',
        launch: recordingLaunch().launch,
      });
      await provider.enable(false);

      const content = writtenPlistContent();
      expect(content).toContain('/Applications/App &amp; &lt;Test&gt;.app');
    });
  });
});
