/**
 * Integration tests for the shell toolset.
 *
 * Tests the full workflow using the bus-backed registry pattern.
 */

import { describe, it, expect, vi } from 'vitest';
import { shellToolset } from '../src/toolset.js';
import { getRequiredShellInstance, setupShellManagerTest } from './tools/shared.js';

describe('shell toolset integration', () => {
  const ctx = setupShellManagerTest();

  describe('toolset structure', () => {
    it('has correct metadata', () => {
      expect(shellToolset.metadata.name).toBe('shell');
      expect(shellToolset.metadata.version).toBe('0.1.0');
    });

    it('exposes all 6 tools via registry', () => {
      const tools = ctx.registry.listTools({ toolsetName: 'shell' });
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('shell_exec');
      expect(toolNames).toContain('shell_status');
      expect(toolNames).toContain('shell_output');
      expect(toolNames).toContain('shell_grep');
      expect(toolNames).toContain('shell_send');
      expect(toolNames).toContain('shell_kill');
      expect(toolNames.length).toBe(6);
    });
  });

  describe('full workflow: exec -> status -> grep -> output', () => {
    it('executes complete workflow', async () => {
      // Step 1: Execute a command
      const execResult = await ctx.registry.execute(
        'shell_exec',
        {
          command: 'echo "line1"; echo "ERROR: something failed"; echo "line3"',
          colors: false,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const execData = execResult.data as { shellId: string; pid: number };
      const shellId = execData.shellId;
      expect(typeof shellId).toBe('string');
      expect(execData.pid).toBeGreaterThan(0);

      // Wait for completion
      const instance = getRequiredShellInstance(ctx.manager, shellId);
      await instance.waitForExit();

      // Step 2: Check status
      const statusResult = await ctx.registry.execute(
        'shell_status',
        { shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(statusResult.success).toBe(true);
      if (!statusResult.success) return;

      const statusData = statusResult.data as {
        status: string;
        exitCode: number;
        stdoutSize: number;
        runtimeMs: number;
      };
      expect(statusData.status).toBe('exited');
      expect(statusData.exitCode).toBe(0);
      expect(statusData.stdoutSize).toBeGreaterThan(0);
      expect(statusData.runtimeMs).toBeGreaterThan(0);

      // Step 3: Grep for errors
      const grepResult = await ctx.registry.execute(
        'shell_grep',
        {
          shellId,
          pattern: 'ERROR',
          stream: 'both',
          context: 1,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(grepResult.success).toBe(true);
      if (!grepResult.success) return;

      const grepData = grepResult.data as {
        matches: Array<{ line: string; before: string[]; after: string[] }>;
      };
      expect(grepData.matches.length).toBe(1);
      expect(grepData.matches[0].line).toContain('ERROR: something failed');
      expect(grepData.matches[0].before).toContain('line1');
      expect(grepData.matches[0].after).toContain('line3');

      // Step 4: Get raw output
      const outputResult = await ctx.registry.execute(
        'shell_output',
        {
          shellId,
          stream: 'stdout',
          offset: 0,
          limit: 10000,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(outputResult.success).toBe(true);
      if (!outputResult.success) return;

      const outputData = outputResult.data as { content: string };
      expect(outputData.content).toContain('line1');
      expect(outputData.content).toContain('ERROR: something failed');
      expect(outputData.content).toContain('line3');
    });
  });

  describe('interactive shell workflow: exec -> send -> output', () => {
    it('sends input to a shell and captures response', async () => {
      // Start a cat command that echoes input
      const execResult = await ctx.registry.execute(
        'shell_exec',
        {
          command: 'cat',
          colors: false,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const execData = execResult.data as { shellId: string };
      const shellId = execData.shellId;

      await vi.waitFor(
        async () => {
          const statusResult = await ctx.registry.execute(
            'shell_status',
            { shellId },
            { contextOverrides: { constraints: ctx.constraints } },
          );
          expect(statusResult.success).toBe(true);
          if (!statusResult.success) return;
          const statusData = statusResult.data as { status: string };
          expect(statusData.status).toBe('running');
        },
        { timeout: 2000, interval: 50 },
      );

      // Send input
      const sendResult = await ctx.registry.execute(
        'shell_send',
        {
          shellId,
          input: 'hello from test\n',
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(sendResult.success).toBe(true);
      if (!sendResult.success) return;
      const sendData = sendResult.data as { sent: boolean; bytesWritten: number };
      expect(sendData.sent).toBe(true);
      expect(sendData.bytesWritten).toBeGreaterThan(0);

      // Wait for cat to process and echo back (poll until output appears)
      await vi.waitFor(
        async () => {
          const outputResult = await ctx.registry.execute(
            'shell_output',
            {
              shellId,
              stream: 'stdout',
              offset: 0,
              limit: 10000,
            },
            { contextOverrides: { constraints: ctx.constraints } },
          );

          expect(outputResult.success).toBe(true);
          if (!outputResult.success) return;
          const outputData = outputResult.data as { content: string };
          expect(outputData.content).toContain('hello from test');
        },
        { timeout: 2000, interval: 50 },
      );

      // Cleanup: kill cat since it won't exit on its own
      const instance = getRequiredShellInstance(ctx.manager, shellId);
      await instance.kill();
      await instance.waitForExit();
    });
  });

  describe('kill workflow: exec -> kill -> status', () => {
    it('kills a running process', async () => {
      // Start a long-running command
      const execResult = await ctx.registry.execute(
        'shell_exec',
        {
          command: 'sleep 60',
          colors: false,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const execData = execResult.data as { shellId: string };
      const shellId = execData.shellId;

      // Verify it's running
      const runningStatus = await ctx.registry.execute(
        'shell_status',
        { shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );
      expect(runningStatus.success).toBe(true);
      if (!runningStatus.success) return;
      const runningData = runningStatus.data as { status: string };
      expect(runningData.status).toBe('running');

      // Kill it
      const killResult = await ctx.registry.execute(
        'shell_kill',
        {
          shellId,
          signal: 'SIGTERM',
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(killResult.success).toBe(true);
      if (!killResult.success) return;
      const killData = killResult.data as { killed: boolean; signal: string };
      expect(killData.killed).toBe(true);
      expect(killData.signal).toBe('SIGTERM');

      // Wait for exit
      const instance = getRequiredShellInstance(ctx.manager, shellId);
      await instance.waitForExit();

      // Verify it's exited
      const exitedStatus = await ctx.registry.execute(
        'shell_status',
        { shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );
      expect(exitedStatus.success).toBe(true);
      if (!exitedStatus.success) return;
      const exitedData = exitedStatus.data as { status: string };
      expect(exitedData.status).toBe('exited');
    });
  });

  describe('stderr handling', () => {
    it('captures and searches stderr separately', async () => {
      // Command that outputs to both stdout and stderr
      const execResult = await ctx.registry.execute(
        'shell_exec',
        {
          command: 'echo "stdout message"; echo "stderr message" >&2',
          colors: false,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const execData = execResult.data as { shellId: string };
      const shellId = execData.shellId;
      const instance = getRequiredShellInstance(ctx.manager, shellId);
      await instance.waitForExit();

      // Grep only stderr
      const grepResult = await ctx.registry.execute(
        'shell_grep',
        {
          shellId,
          pattern: 'message',
          stream: 'stderr',
          context: 0,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(grepResult.success).toBe(true);
      if (!grepResult.success) return;
      const grepData = grepResult.data as {
        matches: Array<{ stream: string }>;
      };
      expect(grepData.matches.length).toBe(1);
      expect(grepData.matches[0].stream).toBe('stderr');

      // Get stderr output only
      const stderrOutput = await ctx.registry.execute(
        'shell_output',
        {
          shellId,
          stream: 'stderr',
          offset: 0,
          limit: 10000,
        },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(stderrOutput.success).toBe(true);
      if (!stderrOutput.success) return;
      const stderrData = stderrOutput.data as { content: string };
      expect(stderrData.content).toContain('stderr message');
      expect(stderrData.content).not.toContain('stdout message');
    });
  });
});
