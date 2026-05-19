import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { ShellManager, type CreateShellOptions } from '../../src/manager/shell-manager.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';

describe('ShellManager', () => {
  let manager: ShellManager;

  const defaultCreateOptions: CreateShellOptions = {
    command: 'echo "hello"',
    cwd: process.cwd(),
    env: {},
    platform: 'posix',
    colors: false,
    constraints: DEFAULT_CONSTRAINTS,
  };

  beforeEach(() => {
    manager = new ShellManager();
  });

  afterEach(async () => {
    manager.stopCleanupTimer();
    await manager.killAll();
  });

  describe('create', () => {
    it('creates and tracks a shell instance', async () => {
      const instance = await manager.create(defaultCreateOptions);

      expect(instance).toBeDefined();
      expect(instance.shellId).toBeDefined();
      expect(instance.pid).toBeGreaterThan(0);

      await instance.waitForExit();
    });

    it('uses detected shell for the platform', async () => {
      const instance = await manager.create({
        ...defaultCreateOptions,
        platform: 'posix',
      });

      // On POSIX, it should detect bash or user's shell
      expect(instance.shell).toBeTruthy();

      await instance.waitForExit();
    });

    it('respects custom timeout', async () => {
      const instance = await manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
        timeout: 100,
      });

      await instance.waitForExit();

      expect(instance.timedOut).toBe(true);
    });

    it('uses constraints timeout when no custom timeout provided', async () => {
      const instance = await manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
        constraints: {
          ...DEFAULT_CONSTRAINTS,
          timeout: 100,
        },
      });

      await instance.waitForExit();

      expect(instance.timedOut).toBe(true);
    });
  });

  describe('get', () => {
    it('returns shell instance by id', async () => {
      const instance = await manager.create(defaultCreateOptions);
      await instance.waitForExit();

      const retrieved = manager.get(instance.shellId);

      expect(retrieved).toBe(instance);
    });

    it('returns undefined for unknown shell id', () => {
      const retrieved = manager.get('nonexistent-id');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('concurrent shell limits', () => {
    it('enforces maxConcurrentShells limit', async () => {
      const constrainedOptions: CreateShellOptions = {
        ...defaultCreateOptions,
        command: 'sleep 10',
        constraints: {
          ...DEFAULT_CONSTRAINTS,
          maxConcurrentShells: 2,
        },
      };

      // Create first two shells (should succeed)
      const shell1 = await manager.create(constrainedOptions);
      const shell2 = await manager.create(constrainedOptions);

      // Third shell should throw
      await expect(manager.create(constrainedOptions)).rejects.toThrow('Max concurrent shells');

      // Cleanup
      await shell1.kill();
      await shell2.kill();
      await Promise.all([shell1.waitForExit(), shell2.waitForExit()]);
    });

    it('allows new shells after existing ones exit', async () => {
      const constrainedOptions: CreateShellOptions = {
        ...defaultCreateOptions,
        command: 'echo "done"',
        constraints: {
          ...DEFAULT_CONSTRAINTS,
          maxConcurrentShells: 1,
        },
      };

      // Create and wait for first shell to finish
      const shell1 = await manager.create(constrainedOptions);
      await shell1.waitForExit();

      // Should now be able to create another
      const shell2 = await manager.create(constrainedOptions);
      await shell2.waitForExit();

      expect(shell2.shellId).not.toBe(shell1.shellId);
    });
  });

  describe('killAll', () => {
    it('kills all running shells', async () => {
      const shell1 = await manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
      });
      const shell2 = await manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
      });

      expect(shell1.getStatus()).toBe('running');
      expect(shell2.getStatus()).toBe('running');

      await manager.killAll();

      await Promise.all([shell1.waitForExit(), shell2.waitForExit()]);

      expect(shell1.getStatus()).toBe('exited');
      expect(shell2.getStatus()).toBe('exited');
    });

    it('handles already exited shells gracefully', async () => {
      const shell = await manager.create(defaultCreateOptions);
      await shell.waitForExit();

      // Should not throw
      await expect(manager.killAll()).resolves.toBeUndefined();
    });
  });

  describe('dispose', () => {
    it('terminates running shells and releases local cleanup state', async () => {
      const shell = await manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
      });
      manager.startCleanupTimer();

      expect(shell.getStatus()).toBe('running');
      expect(manager.get(shell.shellId)).toBe(shell);

      await manager.dispose();
      await shell.waitForExit();

      expect(shell.getStatus()).toBe('exited');
      expect(manager.get(shell.shellId)).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('removes expired shells based on bufferRetentionMs', async () => {
      jest.useFakeTimers();

      try {
        const shell = await manager.create({
          ...defaultCreateOptions,
          constraints: {
            ...DEFAULT_CONSTRAINTS,
            bufferRetentionMs: 1000, // 1 second retention
          },
        });

        await shell.waitForExit();

        // Shell should still be accessible
        expect(manager.get(shell.shellId)).toBe(shell);

        // Advance time past retention
        jest.advanceTimersByTime(2000);

        // Run cleanup
        manager.cleanup();

        // Shell should now be removed
        expect(manager.get(shell.shellId)).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not remove shells that are still running', async () => {
      jest.useFakeTimers();

      try {
        const shell = await manager.create({
          ...defaultCreateOptions,
          command: 'sleep 30',
          constraints: {
            ...DEFAULT_CONSTRAINTS,
            bufferRetentionMs: 100,
          },
        });

        // Advance time past retention
        jest.advanceTimersByTime(500);

        // Run cleanup
        manager.cleanup();

        // Shell should still be accessible (running)
        expect(manager.get(shell.shellId)).toBe(shell);

        // Cleanup
        jest.useRealTimers();
        await shell.kill();
        await shell.waitForExit();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not remove recently exited shells', async () => {
      jest.useFakeTimers();

      try {
        const shell = await manager.create({
          ...defaultCreateOptions,
          constraints: {
            ...DEFAULT_CONSTRAINTS,
            bufferRetentionMs: 10000, // 10 seconds
          },
        });

        await shell.waitForExit();

        // Advance time but not past retention
        jest.advanceTimersByTime(5000);

        // Run cleanup
        manager.cleanup();

        // Shell should still be accessible
        expect(manager.get(shell.shellId)).toBe(shell);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('cleanup timer', () => {
    it('starts and stops cleanup timer', () => {
      // Just verify no errors
      manager.startCleanupTimer(1000);
      manager.stopCleanupTimer();
    });

    it('can be started with custom interval', () => {
      // Just verify no errors
      manager.startCleanupTimer(5000);
      manager.stopCleanupTimer();
    });
  });
});
