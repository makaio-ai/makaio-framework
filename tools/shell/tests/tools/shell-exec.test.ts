import { describe, it, expect } from 'vitest';
import { shellExecTool } from '../../src/tools/shell-exec.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import type { MakaioContext } from '@makaio/core';
import { setupShellManagerTest } from './shared.js';

describe('shellExecTool', () => {
  const ctx = setupShellManagerTest((mgr) => shellExecTool(mgr));

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(ctx.tool.metadata.name).toBe('shell_exec');
      expect(ctx.tool.metadata.description).toContain('shell command');
    });

    it('has destructive annotation', () => {
      expect(ctx.tool.metadata.annotations?.destructive).toBe(true);
    });
  });

  describe('execute', () => {
    it('starts shell and returns shell ID', async () => {
      const result = await ctx.tool.execute({ command: 'echo "hello"', colors: false }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.shellId).toBeDefined();
        expect(typeof result.data.shellId).toBe('string');
        expect(result.data.pid).toBeGreaterThan(0);
        expect(result.data.shell).toBeTruthy();

        // Wait for the shell to finish before cleanup
        const instance = ctx.manager.get(result.data.shellId);
        await instance?.waitForExit();
      }
    });

    it('uses provided cwd', async () => {
      const tmpDir = '/tmp';
      const result = await ctx.tool.execute({ command: 'pwd', cwd: tmpDir, colors: false }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        const instance = ctx.manager.get(result.data.shellId);
        await instance?.waitForExit();

        const output = instance?.getOutput('stdout', 0, 10000);
        // On macOS, /tmp is symlinked to /private/tmp
        expect(output?.content).toMatch(/\/tmp|\/private\/tmp/);
      }
    });

    it('uses context cwd when not provided in input', async () => {
      const customContext: MakaioContext = {
        ...ctx.context,
        cwd: '/tmp',
      };

      const result = await ctx.tool.execute({ command: 'pwd', colors: false }, customContext);

      expect(result.success).toBe(true);
      if (result.success) {
        const instance = ctx.manager.get(result.data.shellId);
        await instance?.waitForExit();

        const output = instance?.getOutput('stdout', 0, 10000);
        expect(output?.content).toMatch(/\/tmp|\/private\/tmp/);
      }
    });

    it('respects max concurrent shells constraint', async () => {
      const constrainedContext: MakaioContext = {
        ...ctx.context,
        constraints: {
          shell: {
            ...DEFAULT_CONSTRAINTS,
            maxConcurrentShells: 1,
          },
        },
      };

      // Start first shell (sleeps to stay running)
      const result1 = await ctx.tool.execute({ command: 'sleep 10', colors: false }, constrainedContext);
      expect(result1.success).toBe(true);

      // Second shell should fail
      const result2 = await ctx.tool.execute({ command: 'echo "second"', colors: false }, constrainedContext);

      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error.code).toBe('RESOURCE_EXHAUSTED');
        expect(result2.error.message).toContain('Max concurrent shells');
      }

      // Cleanup
      if (result1.success) {
        const instance = ctx.manager.get(result1.data.shellId);
        await instance?.kill();
        await instance?.waitForExit();
      }
    });

    it('passes environment variables to shell', async () => {
      const result = await ctx.tool.execute(
        {
          command: 'echo $TEST_VAR',
          env: { TEST_VAR: 'test_value' },
          colors: false,
        },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const instance = ctx.manager.get(result.data.shellId);
        await instance?.waitForExit();

        const output = instance?.getOutput('stdout', 0, 10000);
        expect(output?.content).toContain('test_value');
      }
    });

    it('allows new shell after previous one exits', async () => {
      const constrainedContext: MakaioContext = {
        ...ctx.context,
        constraints: {
          shell: {
            ...DEFAULT_CONSTRAINTS,
            maxConcurrentShells: 1,
          },
        },
      };

      // Start and wait for first shell
      const result1 = await ctx.tool.execute({ command: 'echo "first"', colors: false }, constrainedContext);
      expect(result1.success).toBe(true);

      if (result1.success) {
        const instance1 = ctx.manager.get(result1.data.shellId);
        await instance1?.waitForExit();
      }

      // Second shell should succeed now
      const result2 = await ctx.tool.execute({ command: 'echo "second"', colors: false }, constrainedContext);
      expect(result2.success).toBe(true);

      if (result2.success) {
        const instance2 = ctx.manager.get(result2.data.shellId);
        await instance2?.waitForExit();
      }
    });

    it('respects timeout from input (shorter than constraint)', async () => {
      const result = await ctx.tool.execute(
        {
          command: 'sleep 30',
          timeout: 100,
          colors: false,
        },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const instance = ctx.manager.get(result.data.shellId);
        await instance?.waitForExit();

        expect(instance?.timedOut).toBe(true);
      }
    });
  });
});
