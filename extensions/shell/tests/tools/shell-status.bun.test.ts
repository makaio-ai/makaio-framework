import { describe, it, expect } from 'bun:test';
import { shellStatusTool } from '../../src/tools/shell-status.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import { setupShellManagerTest } from './shared.js';

describe('shellStatusTool', () => {
  const ctx = setupShellManagerTest();

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(shellStatusTool.metadata.name).toBe('shell_status');
      expect(shellStatusTool.metadata.description).toContain('status');
    });

    it('has readOnly annotation', () => {
      expect(shellStatusTool.metadata.annotations?.readOnly).toBe(true);
    });
  });

  describe('execute', () => {
    it('returns status for running shell', async () => {
      const instance = await ctx.manager.create({
        command: 'sleep 10',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      const result = await ctx.registry.execute(
        'shell_status',
        { shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          shellId: string;
          status: string;
          exitCode: number | undefined;
          runtimeMs: number;
        };
        expect(data.shellId).toBe(instance.shellId);
        expect(data.status).toBe('running');
        expect(data.exitCode).toBeUndefined();
        expect(data.runtimeMs).toBeGreaterThan(0);
      }

      // Cleanup
      await instance.kill();
      await instance.waitForExit();
    });

    it('returns status for exited shell', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "done"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_status',
        { shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          shellId: string;
          status: string;
          exitCode: number;
          runtimeMs: number;
        };
        expect(data.shellId).toBe(instance.shellId);
        expect(data.status).toBe('exited');
        expect(data.exitCode).toBe(0);
        expect(data.runtimeMs).toBeGreaterThan(0);
      }
    });

    it('returns correct exit code for failed command', async () => {
      const instance = await ctx.manager.create({
        command: 'exit 42',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_status',
        { shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { status: string; exitCode: number };
        expect(data.status).toBe('exited');
        expect(data.exitCode).toBe(42);
      }
    });

    it('reports output sizes', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "stdout content"; echo "stderr content" >&2',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_status',
        { shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { stdoutSize: number; stderrSize: number };
        expect(data.stdoutSize).toBeGreaterThan(0);
        expect(data.stderrSize).toBeGreaterThan(0);
      }
    });

    it('reports truncated status', async () => {
      const instance = await ctx.manager.create({
        command: 'for i in $(seq 1 100); do echo "line $i with extra content"; done',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: {
          ...DEFAULT_CONSTRAINTS,
          maxOutputSize: 100,
        },
      });

      await instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_status',
        { shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { truncated: boolean };
        expect(data.truncated).toBe(true);
      }
    });

    it('errors for unknown shell ID', async () => {
      const result = await ctx.registry.execute(
        'shell_status',
        { shellId: 'nonexistent-id' },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('Shell not found');
        expect(result.error.message).toContain('nonexistent-id');
      }
    });
  });
});
