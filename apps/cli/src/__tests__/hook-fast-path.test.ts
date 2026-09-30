/**
 * Behavior tests for the light hook path ({@link runLightHookInvocation}).
 *
 * The fast bus connection and the client-hooks runners are mocked; the
 * cool-down is exercised through the real debounce helpers against a temp
 * MAKAIO_HOME.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMakaioHome } from '@makaio/runtime-node';
import { resolveBusUrl } from '../bus-client.js';
import { isHookCoolDownActive, recordBuiltinHookFailure, shouldSkipBusProbe } from '../builtin-hook-debounce.js';
import { tryLightHookPath } from '../hook-fast-path-detect.js';
import type { LightHookInvocation } from '../hook-fast-path-detect.js';

const mocks = vi.hoisted(() => ({
  connectFastHookBus: vi.fn(),
  runClientHookCommand: vi.fn(),
  runClientHookHandleCommand: vi.fn(),
}));

vi.mock('@makaio/inbound-hooks/fast-connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@makaio/inbound-hooks/fast-connection')>()),
  connectFastHookBus: mocks.connectFastHookBus,
}));
vi.mock('@makaio/extension-client-hooks/hook-runner', () => ({
  runClientHookCommand: mocks.runClientHookCommand,
  runClientHookHandleCommand: mocks.runClientHookHandleCommand,
}));

const { runLightHookInvocation, resolveLightBusUrl, resolveLightMakaioHome } = await import('../hook-fast-path.js');

const BUS_URL = 'ws://127.0.0.1:59999/bus';

/**
 * Build an invocation with sensible defaults.
 * @param overrides - Fields to override.
 * @returns The invocation.
 */
function invocation(overrides: Partial<LightHookInvocation> = {}): LightHookInvocation {
  return {
    command: 'received',
    client: 'claude-code',
    eventName: 'PreToolUse',
    metadataJson: '{"a":1}',
    failClose: false,
    noLaunch: false,
    debounceFailure: false,
    ...overrides,
  };
}

describe('runLightHookInvocation', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdinOnSpy: ReturnType<typeof vi.spyOn>;
  let stdinReadSpy: ReturnType<typeof vi.spyOn>;
  const savedExitCode = process.exitCode;
  const dispose = vi.fn();
  const bus = { fake: 'bus' };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-fast-path-'));
    env = { MAKAIO_HOME: tempHome, MAKAIO_BUS_URL: BUS_URL };
    process.exitCode = undefined;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    stdinOnSpy = vi.spyOn(process.stdin, 'on');
    stdinReadSpy = vi.spyOn(process.stdin, 'read');
    mocks.connectFastHookBus.mockReset().mockResolvedValue({ bus, dispose });
    mocks.runClientHookCommand.mockReset().mockResolvedValue(undefined);
    mocks.runClientHookHandleCommand.mockReset().mockResolvedValue(undefined);
    dispose.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns fallback without side effects when the bus is unreachable', async () => {
    mocks.connectFastHookBus.mockResolvedValue(null);

    const result = await runLightHookInvocation(invocation({ command: 'handle', failClose: true }), { env });

    expect(result).toBe('fallback');
    expect(mocks.connectFastHookBus).toHaveBeenCalledWith({ name: 'client-hook-claude-code', busUrl: BUS_URL });
    expect(mocks.runClientHookCommand).not.toHaveBeenCalled();
    expect(mocks.runClientHookHandleCommand).not.toHaveBeenCalled();
    expect(stdinOnSpy).not.toHaveBeenCalled();
    expect(stdinReadSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('returns fallback when the connect attempt throws', async () => {
    mocks.connectFastHookBus.mockRejectedValue(new Error('boom'));

    const result = await runLightHookInvocation(invocation(), { env });

    expect(result).toBe('fallback');
    expect(mocks.runClientHookCommand).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('runs received with the connected bus and disposes once', async () => {
    const result = await runLightHookInvocation(invocation(), { env });

    expect(result).toBe('handled');
    expect(mocks.runClientHookCommand).toHaveBeenCalledWith({
      args: { client: 'claude-code', eventName: 'PreToolUse', metadataJson: '{"a":1}' },
      bus,
    });
    expect(mocks.runClientHookHandleCommand).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('runs handle with an explicit timeout and failClose', async () => {
    const result = await runLightHookInvocation(invocation({ command: 'handle', timeout: 1234, failClose: true }), {
      env,
    });

    expect(result).toBe('handled');
    expect(mocks.runClientHookHandleCommand).toHaveBeenCalledWith({
      args: {
        client: 'claude-code',
        eventName: 'PreToolUse',
        metadataJson: '{"a":1}',
        timeout: 1234,
        failClose: true,
      },
      bus,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('runs handle with the default timeout when none is given', async () => {
    const { DEFAULT_HOOK_HANDLE_TIMEOUT_MS } = await import('@makaio/subsystem-client/hook-subjects');

    await runLightHookInvocation(invocation({ command: 'handle' }), { env });

    expect(mocks.runClientHookHandleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ timeout: DEFAULT_HOOK_HANDLE_TIMEOUT_MS, failClose: false }),
      }),
    );
  });

  it('disposes exactly once when the runner throws', async () => {
    mocks.runClientHookCommand.mockRejectedValue(new Error('runner failed'));

    const result = await runLightHookInvocation(invocation(), { env });

    expect(result).toBe('handled');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  describe('failure cool-down', () => {
    /**
     * Record an active hook cool-down for the test bus URL and home.
     * @param command - Hook command the failure is recorded for.
     */
    function recordCoolDown(command: 'handle' | 'received'): void {
      recordBuiltinHookFailure(
        ['node', 'makaio', 'hook', command],
        true,
        { fallback: 'unreachable', probeSkipped: false },
        BUS_URL,
        tempHome,
      );
    }

    it('runs with a null bus and no connect attempt when a cool-down is active', async () => {
      recordCoolDown('received');

      const result = await runLightHookInvocation(invocation({ debounceFailure: true }), { env });

      expect(result).toBe('handled');
      expect(mocks.connectFastHookBus).not.toHaveBeenCalled();
      expect(mocks.runClientHookCommand).toHaveBeenCalledWith({
        args: { client: 'claude-code', eventName: 'PreToolUse', metadataJson: '{"a":1}' },
        bus: null,
      });
      expect(dispose).not.toHaveBeenCalled();
    });

    it('ignores the cool-down without debounceFailure', async () => {
      recordCoolDown('received');

      await runLightHookInvocation(invocation(), { env });

      expect(mocks.connectFastHookBus).toHaveBeenCalledTimes(1);
    });

    it('ignores the cool-down under failClose', async () => {
      recordCoolDown('handle');

      const result = await runLightHookInvocation(
        invocation({ command: 'handle', debounceFailure: true, failClose: true }),
        { env },
      );

      expect(result).toBe('handled');
      expect(mocks.connectFastHookBus).toHaveBeenCalledTimes(1);
      expect(mocks.runClientHookHandleCommand).toHaveBeenCalledWith(expect.objectContaining({ bus }));
    });
  });

  describe('runner failure after connect', () => {
    it('fails open silently without failClose', async () => {
      mocks.runClientHookHandleCommand.mockRejectedValue(new Error('nope'));

      await expect(runLightHookInvocation(invocation({ command: 'handle' }), { env })).resolves.toBe('handled');

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('writes one stderr line and sets exitCode 1 under failClose', async () => {
      mocks.runClientHookHandleCommand.mockRejectedValue(new Error('nope'));

      await expect(runLightHookInvocation(invocation({ command: 'handle', failClose: true }), { env })).resolves.toBe(
        'handled',
      );

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith('[hook handle] error: nope\n');
      expect(process.exitCode).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });
});

describe('light resolver parity', () => {
  const savedHome = process.env['MAKAIO_HOME'];
  const savedBusUrl = process.env['MAKAIO_BUS_URL'];

  afterEach(() => {
    if (savedHome === undefined) delete process.env['MAKAIO_HOME'];
    else process.env['MAKAIO_HOME'] = savedHome;
    if (savedBusUrl === undefined) delete process.env['MAKAIO_BUS_URL'];
    else process.env['MAKAIO_BUS_URL'] = savedBusUrl;
  });

  const cases: ReadonlyArray<[string, string | undefined]> = [
    ['unset', undefined],
    ['set', '/tmp/some-home'],
    ['whitespace-padded', '  /tmp/padded-home  '],
    ['whitespace-only', '   '],
    ['empty', ''],
  ];

  it.each(cases)('MAKAIO_HOME (%s) matches resolveMakaioHome', (_label, value) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { MAKAIO_HOME: value };
    expect(resolveLightMakaioHome(env)).toBe(resolveMakaioHome(env));
  });

  it.each([
    ['unset', undefined],
    ['set', 'ws://example.test:1234/bus'],
    ['whitespace-padded', '  ws://example.test:1234/bus  '],
    ['whitespace-only', '   '],
    ['empty', ''],
  ] as ReadonlyArray<[string, string | undefined]>)('MAKAIO_BUS_URL (%s) matches resolveBusUrl', (_label, value) => {
    if (value === undefined) delete process.env['MAKAIO_BUS_URL'];
    else process.env['MAKAIO_BUS_URL'] = value;
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { MAKAIO_BUS_URL: value };
    expect(resolveLightBusUrl(env)).toBe(resolveBusUrl());
  });
});

describe('tryLightHookPath', () => {
  const lightArgv = ['node', 'makaio', 'hook', 'received', 'claude-code', 'PreToolUse'];
  const savedExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
  });

  it('returns false without calling the loader for a non-light argv', async () => {
    const loadRunner = vi.fn();

    await expect(tryLightHookPath(['node', 'makaio', 'status'], loadRunner)).resolves.toBe(false);

    expect(loadRunner).not.toHaveBeenCalled();
  });

  it('returns false without output when the loader rejects', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const loadRunner = vi.fn().mockRejectedValue(new Error('load failed'));

    await expect(tryLightHookPath(lightArgv, loadRunner)).resolves.toBe(false);

    expect(loadRunner).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['handled', true],
    ['fallback', false],
  ] as const)('maps runner result %s to %s', async (outcome, expected) => {
    const runLightHookInvocation = vi.fn().mockResolvedValue(outcome);

    await expect(tryLightHookPath(lightArgv, async () => ({ runLightHookInvocation }))).resolves.toBe(expected);

    expect(runLightHookInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'received', client: 'claude-code', eventName: 'PreToolUse' }),
    );
  });
});

describe('isHookCoolDownActive', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cooldown-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /**
   * Record an active cool-down for the test bus URL in the temp home.
   */
  function recordActive(): void {
    recordBuiltinHookFailure(
      ['node', 'makaio', 'hook', 'received'],
      true,
      { fallback: 'unreachable', probeSkipped: false },
      BUS_URL,
      tempHome,
    );
  }

  const options = (overrides: { debounceFailure?: boolean; failClose?: boolean } = {}) => ({
    debounceFailure: true,
    failClose: false,
    busUrl: BUS_URL,
    makaioHome: tempHome,
    ...overrides,
  });

  it('is false when debounceFailure is off, even with an active record', () => {
    recordActive();
    expect(isHookCoolDownActive(options({ debounceFailure: false }))).toBe(false);
  });

  it('is false under failClose, even with an active record', () => {
    recordActive();
    expect(isHookCoolDownActive(options({ failClose: true }))).toBe(false);
  });

  it('is false without a record', () => {
    expect(isHookCoolDownActive(options())).toBe(false);
  });

  it('is true with an active record written by recordBuiltinHookFailure', () => {
    recordActive();
    expect(isHookCoolDownActive(options())).toBe(true);
  });

  it('matches shouldSkipBusProbe for the equivalent argv', () => {
    const argv = ['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse'];
    const failCloseArgv = [...argv, '--fail-close'];

    expect(shouldSkipBusProbe(argv, true, BUS_URL, tempHome)).toBe(false);
    recordActive();
    expect(shouldSkipBusProbe(argv, true, BUS_URL, tempHome)).toBe(isHookCoolDownActive(options()));
    expect(shouldSkipBusProbe(argv, true, BUS_URL, tempHome)).toBe(true);
    expect(shouldSkipBusProbe(argv, false, BUS_URL, tempHome)).toBe(false);
    expect(shouldSkipBusProbe(failCloseArgv, true, BUS_URL, tempHome)).toBe(
      isHookCoolDownActive(options({ failClose: true })),
    );
    expect(shouldSkipBusProbe(['node', 'makaio', 'status'], true, BUS_URL, tempHome)).toBe(false);
  });
});
