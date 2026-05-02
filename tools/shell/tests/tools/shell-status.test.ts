import { describe, it, expect } from 'vitest';
import { shellStatusTool } from '../../src/tools/shell-status.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import { setupShellManagerTest } from './shared.js';

describe('shellStatusTool', () => {
  const ctx = setupShellManagerTest((mgr) => shellStatusTool(mgr));

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(ctx.tool.metadata.name).toBe('shell_status');
      expect(ctx.tool.metadata.description).toContain('status');
    });

    it('has readOnly annotation', () => {
      expect(ctx.tool.metadata.annotations?.readOnly).toBe(true);
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

      const result = await ctx.tool.execute({ shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.shellId).toBe(instance.shellId);
        expect(result.data.status).toBe('running');
        expect(result.data.exitCode).toBeUndefined();
        expect(result.data.runtimeMs).toBeGreaterThan(0);
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

      const result = await ctx.tool.execute({ shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.shellId).toBe(instance.shellId);
        expect(result.data.status).toBe('exited');
        expect(result.data.exitCode).toBe(0);
        expect(result.data.runtimeMs).toBeGreaterThan(0);
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

      const result = await ctx.tool.execute({ shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('exited');
        expect(result.data.exitCode).toBe(42);
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

      const result = await ctx.tool.execute({ shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdoutSize).toBeGreaterThan(0);
        expect(result.data.stderrSize).toBeGreaterThan(0);
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

      const result = await ctx.tool.execute({ shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.truncated).toBe(true);
      }
    });

    it('errors for unknown shell ID', async () => {
      const result = await ctx.tool.execute({ shellId: 'nonexistent-id' }, ctx.context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('Shell not found');
        expect(result.error.message).toContain('nonexistent-id');
      }
    });
  });
});
