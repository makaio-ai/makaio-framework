/**
 * Integration tests for the shell toolset.
 *
 * Tests the full workflow using tool factories directly for type safety.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createShellToolset } from '../src/toolset.js';
import { ShellManager } from '../src/manager/shell-manager.js';
import {
  shellExecTool,
  shellStatusTool,
  shellOutputTool,
  shellGrepTool,
  shellSendTool,
  shellKillTool,
} from '../src/tools/index.js';
import { DEFAULT_CONSTRAINTS } from '../src/types.js';
import type { MakaioContext } from '@makaio/core';

describe('shell toolset integration', () => {
  let manager: ShellManager;

  const context: MakaioContext = {
    cwd: process.cwd(),
    env: {},
    platform: 'posix',
    constraints: {
      shell: DEFAULT_CONSTRAINTS,
    },
  };

  afterEach(async () => {
    if (manager) {
      manager.stopCleanupTimer();
      await manager.killAll();
    }
  });

  describe('createShellToolset', () => {
    it('creates toolset with all tools', () => {
      const { toolset, manager: mgr } = createShellToolset();
      manager = mgr;
      manager.stopCleanupTimer();

      expect(toolset.metadata.name).toBe('shell');
      expect(toolset.metadata.version).toBe('0.1.0');

      // Verify all 6 tools are present
      const toolNames = Object.keys(toolset.tools);
      expect(toolNames).toContain('shell_exec');
      expect(toolNames).toContain('shell_status');
      expect(toolNames).toContain('shell_output');
      expect(toolNames).toContain('shell_grep');
      expect(toolNames).toContain('shell_send');
      expect(toolNames).toContain('shell_kill');
      expect(toolNames.length).toBe(6);
    });

    it('accepts existing manager', () => {
      const { manager: manager1 } = createShellToolset();
      manager = manager1;
      manager1.stopCleanupTimer();

      const { manager: manager2 } = createShellToolset({ manager: manager1 });
      manager2.stopCleanupTimer();

      expect(manager2).toBe(manager1);
    });
  });

  describe('full workflow: exec -> status -> grep -> output', () => {
    it('executes complete workflow', async () => {
      manager = new ShellManager();

      const execTool = shellExecTool(manager);
      const statusTool = shellStatusTool(manager);
      const grepTool = shellGrepTool(manager);
      const outputTool = shellOutputTool(manager);

      // Step 1: Execute a command
      const execResult = await execTool.execute(
        {
          command: 'echo "line1"; echo "ERROR: something failed"; echo "line3"',
          colors: false,
        },
        context,
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const shellId = execResult.data.shellId;
      expect(typeof shellId).toBe('string');
      expect(execResult.data.pid).toBeGreaterThan(0);

      // Wait for completion
      const instance = manager.get(shellId);
      await instance?.waitForExit();

      // Step 2: Check status
      const statusResult = await statusTool.execute({ shellId }, context);

      expect(statusResult.success).toBe(true);
      if (!statusResult.success) return;

      expect(statusResult.data.status).toBe('exited');
      expect(statusResult.data.exitCode).toBe(0);
      expect(statusResult.data.stdoutSize).toBeGreaterThan(0);
      expect(statusResult.data.runtimeMs).toBeGreaterThan(0);

      // Step 3: Grep for errors
      const grepResult = await grepTool.execute(
        {
          shellId,
          pattern: 'ERROR',
          stream: 'both',
          context: 1,
          maxMatches: 10,
          offset: 0,
        },
        context,
      );

      expect(grepResult.success).toBe(true);
      if (!grepResult.success) return;

      expect(grepResult.data.matches.length).toBe(1);
      expect(grepResult.data.matches[0].line).toContain('ERROR: something failed');
      expect(grepResult.data.matches[0].before).toContain('line1');
      expect(grepResult.data.matches[0].after).toContain('line3');

      // Step 4: Get raw output
      const outputResult = await outputTool.execute(
        {
          shellId,
          stream: 'stdout',
          offset: 0,
          limit: 10000,
        },
        context,
      );

      expect(outputResult.success).toBe(true);
      if (!outputResult.success) return;

      expect(outputResult.data.content).toContain('line1');
      expect(outputResult.data.content).toContain('ERROR: something failed');
      expect(outputResult.data.content).toContain('line3');
    });
  });

  describe('interactive shell workflow: exec -> send -> output', () => {
    it('sends input to a shell and captures response', async () => {
      manager = new ShellManager();

      const execTool = shellExecTool(manager);
      const sendTool = shellSendTool(manager);
      const statusTool = shellStatusTool(manager);
      const outputTool = shellOutputTool(manager);

      // Start a cat command that echoes input
      const execResult = await execTool.execute(
        {
          command: 'cat',
          colors: false,
        },
        context,
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const shellId = execResult.data.shellId;

      // Give cat a moment to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check it's running
      const statusResult = await statusTool.execute({ shellId }, context);
      expect(statusResult.success).toBe(true);
      if (!statusResult.success) return;
      expect(statusResult.data.status).toBe('running');

      // Send input
      const sendResult = await sendTool.execute(
        {
          shellId,
          input: 'hello from test\n',
        },
        context,
      );

      expect(sendResult.success).toBe(true);
      if (!sendResult.success) return;
      expect(sendResult.data.sent).toBe(true);
      expect(sendResult.data.bytesWritten).toBeGreaterThan(0);

      // Wait for cat to process and echo back (poll until output appears)
      await vi.waitFor(
        async () => {
          const outputResult = await outputTool.execute(
            {
              shellId,
              stream: 'stdout',
              offset: 0,
              limit: 10000,
            },
            context,
          );

          expect(outputResult.success).toBe(true);
          if (!outputResult.success) return;
          expect(outputResult.data.content).toContain('hello from test');
        },
        { timeout: 2000, interval: 50 },
      );
    });
  });

  describe('kill workflow: exec -> kill -> status', () => {
    it('kills a running process', async () => {
      manager = new ShellManager();

      const execTool = shellExecTool(manager);
      const killTool = shellKillTool(manager);
      const statusTool = shellStatusTool(manager);

      // Start a long-running command
      const execResult = await execTool.execute(
        {
          command: 'sleep 60',
          colors: false,
        },
        context,
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const shellId = execResult.data.shellId;

      // Verify it's running
      const runningStatus = await statusTool.execute({ shellId }, context);
      expect(runningStatus.success).toBe(true);
      if (!runningStatus.success) return;
      expect(runningStatus.data.status).toBe('running');

      // Kill it
      const killResult = await killTool.execute(
        {
          shellId,
          signal: 'SIGTERM',
        },
        context,
      );

      expect(killResult.success).toBe(true);
      if (!killResult.success) return;
      expect(killResult.data.killed).toBe(true);
      expect(killResult.data.signal).toBe('SIGTERM');

      // Wait for exit
      const instance = manager.get(shellId);
      await instance?.waitForExit();

      // Verify it's exited
      const exitedStatus = await statusTool.execute({ shellId }, context);
      expect(exitedStatus.success).toBe(true);
      if (!exitedStatus.success) return;
      expect(exitedStatus.data.status).toBe('exited');
    });
  });

  describe('stderr handling', () => {
    it('captures and searches stderr separately', async () => {
      manager = new ShellManager();

      const execTool = shellExecTool(manager);
      const grepTool = shellGrepTool(manager);
      const outputTool = shellOutputTool(manager);

      // Command that outputs to both stdout and stderr
      const execResult = await execTool.execute(
        {
          command: 'echo "stdout message"; echo "stderr message" >&2',
          colors: false,
        },
        context,
      );

      expect(execResult.success).toBe(true);
      if (!execResult.success) return;

      const shellId = execResult.data.shellId;
      const instance = manager.get(shellId);
      await instance?.waitForExit();

      // Grep only stderr
      const grepResult = await grepTool.execute(
        {
          shellId,
          pattern: 'message',
          stream: 'stderr',
          context: 0,
          maxMatches: 10,
          offset: 0,
        },
        context,
      );

      expect(grepResult.success).toBe(true);
      if (!grepResult.success) return;
      expect(grepResult.data.matches.length).toBe(1);
      expect(grepResult.data.matches[0].stream).toBe('stderr');

      // Get stderr output only
      const stderrOutput = await outputTool.execute(
        {
          shellId,
          stream: 'stderr',
          offset: 0,
          limit: 10000,
        },
        context,
      );

      expect(stderrOutput.success).toBe(true);
      if (!stderrOutput.success) return;
      expect(stderrOutput.data.content).toContain('stderr message');
      expect(stderrOutput.data.content).not.toContain('stdout message');
    });
  });
});
