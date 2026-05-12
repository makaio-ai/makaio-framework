import { describe, it, expect, afterEach } from 'vitest';
import { ShellInstance, type ShellInstanceOptions } from '../../src/manager/shell-instance.js';

describe('ShellInstance', () => {
  let instance: ShellInstance | undefined;

  const defaultOptions: ShellInstanceOptions = {
    command: 'echo "hello"',
    shell: 'bash',
    cwd: process.cwd(),
    env: {},
    colors: false,
    maxOutputSize: 1024 * 1024,
    timeout: 5000,
  };

  afterEach(async () => {
    if (instance) {
      try {
        await instance.kill('SIGKILL');
      } catch {
        // Ignore errors during cleanup
      }
      instance = undefined;
    }
  });

  describe('basic execution', () => {
    it('executes command and captures stdout', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "hello world"',
      });

      await instance.waitForExit();

      const output = instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('hello world');
      expect(instance.getStatus()).toBe('exited');
      expect(instance.getExitCode()).toBe(0);
    });

    it('captures stderr', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "error message" >&2',
      });

      await instance.waitForExit();

      const output = instance.getOutput('stderr', 0, 10000);
      expect(output.content).toContain('error message');
    });

    it('captures both stdout and stderr interleaved', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "out"; echo "err" >&2',
      });

      await instance.waitForExit();

      const output = instance.getOutput('both', 0, 10000);
      expect(output.content).toContain('out');
      expect(output.content).toContain('err');
    });

    it('reports correct exit code for failing command', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'exit 42',
      });

      await instance.waitForExit();

      expect(instance.getStatus()).toBe('exited');
      expect(instance.getExitCode()).toBe(42);
    });
  });

  describe('status reporting', () => {
    it('reports running status while command executes', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'sleep 10',
      });

      expect(instance.getStatus()).toBe('running');

      await instance.kill();
      await instance.waitForExit();
    });

    it('reports exited status after command completes', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "done"',
      });

      await instance.waitForExit();

      expect(instance.getStatus()).toBe('exited');
    });

    it('provides runtime in milliseconds', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'sleep 0.1',
      });

      await instance.waitForExit();

      const runtime = instance.getRuntimeMs();
      expect(runtime).toBeGreaterThan(50);
      expect(runtime).toBeLessThan(5000);
    });
  });

  describe('buffer statistics', () => {
    it('tracks stdout size', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "12345"',
      });

      await instance.waitForExit();

      const stats = instance.getBufferStats();
      expect(stats.stdoutSize).toBeGreaterThan(0);
    });

    it('tracks stderr size', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "error" >&2',
      });

      await instance.waitForExit();

      const stats = instance.getBufferStats();
      expect(stats.stderrSize).toBeGreaterThan(0);
    });

    it('reports truncated status when buffer exceeds max', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'for i in $(seq 1 100); do echo "line $i with some extra content"; done',
        maxOutputSize: 100,
      });

      await instance.waitForExit();

      const stats = instance.getBufferStats();
      expect(stats.truncated).toBe(true);
      expect(stats.totalSize).toBeLessThanOrEqual(100);
    });
  });

  describe('line-based output', () => {
    it('returns output as lines', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "line1"; echo "line2"; echo "line3"',
      });

      await instance.waitForExit();

      const lines = instance.getLines('stdout');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0].content).toBe('line1');
      expect(lines[1].content).toBe('line2');
      expect(lines[2].content).toBe('line3');
    });

    it('returns stderr lines separately', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "stdout"; echo "stderr" >&2',
      });

      await instance.waitForExit();

      const stdoutLines = instance.getLines('stdout');
      const stderrLines = instance.getLines('stderr');

      expect(stdoutLines.some((l) => l.content === 'stdout')).toBe(true);
      expect(stderrLines.some((l) => l.content === 'stderr')).toBe(true);
    });
  });

  describe('input handling', () => {
    it('can send input to stdin', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'read line; echo "got: $line"',
      });

      const bytesWritten = await instance.sendInput('test input\n');
      expect(bytesWritten).toBeGreaterThan(0);

      await instance.waitForExit();

      const output = instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('got: test input');
    });

    it('returns 0 bytes when sending input to exited process', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "done"',
      });

      await instance.waitForExit();

      const bytesWritten = await instance.sendInput('too late\n');
      expect(bytesWritten).toBe(0);
    });
  });

  describe('timeout handling', () => {
    it('respects timeout', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'sleep 30',
        timeout: 100,
      });

      await instance.waitForExit();

      expect(instance.timedOut).toBe(true);
      expect(instance.getStatus()).toBe('exited');
    });
  });

  describe('kill functionality', () => {
    it('kills running process with SIGTERM', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'sleep 30',
      });

      expect(instance.getStatus()).toBe('running');

      const killed = await instance.kill('SIGTERM');
      expect(killed).toBe(true);

      await instance.waitForExit();
      expect(instance.getStatus()).toBe('exited');
    });

    it('kills running process with SIGKILL', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'sleep 30',
      });

      const killed = await instance.kill('SIGKILL');
      expect(killed).toBe(true);

      await instance.waitForExit();
      expect(instance.getStatus()).toBe('exited');
    });

    it('returns false when killing already exited process', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'echo "done"',
      });

      await instance.waitForExit();

      const killed = await instance.kill();
      expect(killed).toBe(false);
    });
  });

  describe('properties', () => {
    it('has a unique shellId', () => {
      instance = new ShellInstance(defaultOptions);

      expect(instance.shellId).toBeDefined();
      expect(typeof instance.shellId).toBe('string');
      expect(instance.shellId.length).toBeGreaterThan(0);
    });

    it('has a pid', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'sleep 1',
      });

      expect(instance.pid).toBeGreaterThan(0);

      await instance.kill();
      await instance.waitForExit();
    });

    it('has the correct shell', () => {
      instance = new ShellInstance({
        ...defaultOptions,
        shell: 'bash',
      });

      expect(instance.shell).toBe('bash');
    });

    it('has a startTime', () => {
      const before = Date.now();
      instance = new ShellInstance(defaultOptions);
      const after = Date.now();

      expect(instance.startTime).toBeGreaterThanOrEqual(before);
      expect(instance.startTime).toBeLessThanOrEqual(after);
    });
  });

  describe('ANSI handling', () => {
    it('strips ANSI codes when colors is false', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'printf "\\033[31mred\\033[0m"',
        colors: false,
      });

      await instance.waitForExit();

      const output = instance.getOutput('stdout', 0, 10000);
      expect(output.content).toBe('red');
      expect(output.content).not.toContain('\x1b');
    });

    it('preserves ANSI codes when colors is true', async () => {
      instance = new ShellInstance({
        ...defaultOptions,
        command: 'printf "\\033[31mred\\033[0m"',
        colors: true,
      });

      await instance.waitForExit();

      const output = instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('\x1b[31m');
    });
  });
});
