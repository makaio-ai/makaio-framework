import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts';
import { createMockBus } from '@makaio/test-utils';
import { attachInteractiveTerminal } from './terminal-attachment-command.js';
import { createTestTTYFixture } from './test-tty-fixture.js';

describe('attachInteractiveTerminal', () => {
  const ttyFixture = createTestTTYFixture();
  const originalRawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');

  afterEach(() => {
    ttyFixture.restore();
    restoreDescriptor(process.stdin, 'setRawMode', originalRawMode);
    restoreDescriptor(process.stdout, 'columns', originalColumns);
    restoreDescriptor(process.stdout, 'rows', originalRows);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('relays input and resize, then detaches and restores raw mode without stopping the runtime', async () => {
    ttyFixture.snapshot();
    ttyFixture.set({ stdinIsTTY: true, stdoutIsTTY: true });
    const setRawMode = vi.fn();
    const pause = vi.spyOn(process.stdin, 'pause');
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawMode });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 40 });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });
    request.mockResolvedValueOnce({ success: true, lastSeq: 0, bufferedOutput: '' });

    const attach = attachInteractiveTerminal(bus, { supervisorSessionId: 'supervisor-1' });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.terminal.open, expect.anything()),
    );

    process.stdin.emit('data', Buffer.from('/compact'));
    process.emit('SIGWINCH');
    process.stdin.emit('data', Buffer.from('\u001d'));
    await attach;

    const attachmentId = (request.mock.calls[0]?.[1] as { attachmentId: string }).attachmentId;
    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.terminal.input, {
      attachmentId,
      data: '/compact',
    });
    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.terminal.resize, {
      attachmentId,
      cols: 120,
      rows: 40,
    });
    expect(request).toHaveBeenLastCalledWith(NativeSessionSupervisorSubjects.terminal.close, { attachmentId });
    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('restores raw mode when the supervised PTY closes the attachment', async () => {
    ttyFixture.snapshot();
    ttyFixture.set({ stdinIsTTY: true, stdoutIsTTY: true });
    const setRawMode = vi.fn();
    const pause = vi.spyOn(process.stdin, 'pause');
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawMode });
    const handlers = new Map<unknown, (event: { payload: { attachmentId: string } }) => void>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ success: true, lastSeq: 0, bufferedOutput: '' })
      .mockResolvedValueOnce({ success: true });
    const bus = {
      on: vi.fn((subject, handler) => {
        handlers.set(subject, handler);
        return () => undefined;
      }),
      request,
      emit: vi.fn().mockResolvedValue(undefined),
    };

    const attach = attachInteractiveTerminal(bus as never, { supervisorSessionId: 'supervisor-1' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const attachmentId = (request.mock.calls[0]?.[1] as { attachmentId: string }).attachmentId;
    handlers.get(NativeSessionSupervisorSubjects.terminal.closed)?.({ payload: { attachmentId } });
    await attach;

    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)('restores raw mode and re-raises %s', async (signal) => {
    ttyFixture.snapshot();
    ttyFixture.set({ stdinIsTTY: true, stdoutIsTTY: true });
    const setRawMode = vi.fn();
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawMode });
    const priorListeners = new Set(process.listeners(signal));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });
    request.mockResolvedValueOnce({ success: true, lastSeq: 0, bufferedOutput: '' });

    const attach = attachInteractiveTerminal(bus, { supervisorSessionId: 'supervisor-1' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const listener = process.listeners(signal).find((candidate) => !priorListeners.has(candidate));
    expect(listener).toBeDefined();

    listener?.(signal);
    await attach;

    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.listeners(signal)).not.toContain(listener);
    expect(kill).toHaveBeenCalledWith(process.pid, signal);
  });

  it('restores raw mode synchronously when the process exits', async () => {
    ttyFixture.snapshot();
    ttyFixture.set({ stdinIsTTY: true, stdoutIsTTY: true });
    const setRawMode = vi.fn();
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawMode });
    const priorListeners = new Set(process.listeners('exit'));
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });
    request.mockResolvedValueOnce({ success: true, lastSeq: 0, bufferedOutput: '' });

    const attach = attachInteractiveTerminal(bus, { supervisorSessionId: 'supervisor-1' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const listener = process.listeners('exit').find((candidate) => !priorListeners.has(candidate));
    expect(listener).toBeDefined();

    listener?.(0);
    await attach;

    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.listeners('exit')).not.toContain(listener);
  });

  it('preserves a UTF-8 character split across stdin chunks', async () => {
    ttyFixture.snapshot();
    ttyFixture.set({ stdinIsTTY: true, stdoutIsTTY: true });
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: vi.fn() });
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });
    request.mockResolvedValueOnce({ success: true, lastSeq: 0, bufferedOutput: '' });

    const attach = attachInteractiveTerminal(bus, { supervisorSessionId: 'supervisor-1' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    process.stdin.emit('data', Buffer.from([0xe2, 0x82]));
    process.stdin.emit('data', Buffer.from([0xac]));
    process.stdin.emit('data', Buffer.from('\u001d'));
    await attach;

    const attachmentId = (request.mock.calls[0]?.[1] as { attachmentId: string }).attachmentId;
    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.terminal.input, { attachmentId, data: '€' });
  });
});

/**
 * Restore an own property descriptor or remove the test-created property.
 * @param target - Object whose property was overridden for the test.
 * @param key - Property key to restore.
 * @param descriptor - Original own descriptor, if one existed.
 */
function restoreDescriptor<T extends object>(
  target: T,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}
