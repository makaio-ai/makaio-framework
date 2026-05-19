import { describe, it, expect } from 'bun:test';
import { shellExecTool } from '../../src/tools/shell-exec.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import { getRequiredShellInstance, setupShellManagerTest } from './shared.js';

describe('shellExecTool', () => {
  const ctx = setupShellManagerTest();

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(shellExecTool.metadata.name).toBe('shell_exec');
      expect(shellExecTool.metadata.description).toContain('shell command');
    });

    it('has destructive annotation', () => {
      expect(shellExecTool.metadata.annotations?.destructive).toBe(true);
    });
  });

  describe('execute', () => {
    it('starts shell and returns shell ID', async () => {
      const result = await ctx.registry.execute(
        'shell_exec',
        { command: 'echo "hello"', colors: false },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { shellId: string; pid: number; shell: string };
        expect(data.shellId).toBeDefined();
        expect(typeof data.shellId).toBe('string');
        expect(data.pid).toBeGreaterThan(0);
        expect(data.shell).toBeTruthy();

        // Wait for the shell to finish before cleanup
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.waitForExit();
      }
    });

    it('uses provided cwd', async () => {
      const tmpDir = '/tmp';
      const result = await ctx.registry.execute(
        'shell_exec',
        { command: 'pwd', cwd: tmpDir, colors: false },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { shellId: string };
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.waitForExit();

        const output = instance.getOutput('stdout', 0, 10000);
        // On macOS, /tmp is symlinked to /private/tmp
        expect(output.content).toMatch(/\/tmp|\/private\/tmp/);
      }
    });

    it('uses context cwd when not provided in input', async () => {
      const result = await ctx.registry.execute(
        'shell_exec',
        { command: 'pwd', colors: false },
        { contextOverrides: { cwd: '/tmp', constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { shellId: string };
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.waitForExit();

        const output = instance.getOutput('stdout', 0, 10000);
        expect(output.content).toMatch(/\/tmp|\/private\/tmp/);
      }
    });

    it('respects max concurrent shells constraint', async () => {
      const constrainedConstraints = {
        shell: {
          ...DEFAULT_CONSTRAINTS,
          maxConcurrentShells: 1,
        },
      };

      // Start first shell (sleeps to stay running)
      const result1 = await ctx.registry.execute(
        'shell_exec',
        { command: 'sleep 10', colors: false },
        { contextOverrides: { constraints: constrainedConstraints } },
      );
      expect(result1.success).toBe(true);

      // Second shell should fail
      const result2 = await ctx.registry.execute(
        'shell_exec',
        { command: 'echo "second"', colors: false },
        { contextOverrides: { constraints: constrainedConstraints } },
      );

      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error.code).toBe('RESOURCE_EXHAUSTED');
        expect(result2.error.message).toContain('Max concurrent shells');
      }

      // Cleanup
      if (result1.success) {
        const data = result1.data as { shellId: string };
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.kill();
        await instance.waitForExit();
      }
    });

    it('falls back to default limits for invalid numeric constraints', async () => {
      const result = await ctx.registry.execute(
        'shell_exec',
        { command: 'echo "sanitized"', colors: false },
        {
          contextOverrides: {
            constraints: {
              shell: {
                ...DEFAULT_CONSTRAINTS,
                maxConcurrentShells: 0,
                timeout: Number.POSITIVE_INFINITY,
                maxOutputSize: Number.NaN,
                bufferRetentionMs: -1,
              },
            },
          },
        },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { shellId: string };
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.waitForExit();

        expect(instance.getStatus()).toBe('exited');
      }
    });

    it('passes environment variables to shell', async () => {
      const result = await ctx.registry.execute(
        'shell_exec',
        {
          command: 'echo $TEST_VAR',
          env: { TEST_VAR: 'test_value' },
          colors: false,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { shellId: string };
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.waitForExit();

        const output = instance.getOutput('stdout', 0, 10000);
        expect(output.content).toContain('test_value');
      }
    });

    it('allows new shell after previous one exits', async () => {
      const constrainedConstraints = {
        shell: {
          ...DEFAULT_CONSTRAINTS,
          maxConcurrentShells: 1,
        },
      };

      // Start and wait for first shell
      const result1 = await ctx.registry.execute(
        'shell_exec',
        { command: 'echo "first"', colors: false },
        { contextOverrides: { constraints: constrainedConstraints } },
      );
      expect(result1.success).toBe(true);

      if (result1.success) {
        const data = result1.data as { shellId: string };
        const instance1 = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance1.waitForExit();
      }

      // Second shell should succeed now
      const result2 = await ctx.registry.execute(
        'shell_exec',
        { command: 'echo "second"', colors: false },
        { contextOverrides: { constraints: constrainedConstraints } },
      );
      expect(result2.success).toBe(true);

      if (result2.success) {
        const data = result2.data as { shellId: string };
        const instance2 = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance2.waitForExit();
      }
    });

    it('respects timeout from input (shorter than constraint)', async () => {
      const result = await ctx.registry.execute(
        'shell_exec',
        {
          command: 'sleep 30',
          timeout: 100,
          colors: false,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { shellId: string };
        const instance = getRequiredShellInstance(ctx.manager, data.shellId);
        await instance.waitForExit();

        expect(instance.timedOut).toBe(true);
      }
    });
  });
});
