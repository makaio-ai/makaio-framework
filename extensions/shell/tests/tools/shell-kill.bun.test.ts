import { describe, it, expect } from 'bun:test';
import { shellKillTool } from '../../src/tools/shell-kill.js';
import { createDefaultCreateOptions, setupShellToolTest } from './shared.js';

describe('shellKillTool', () => {
  const ctx = setupShellToolTest();

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(shellKillTool.metadata.name).toBe('shell_kill');
      expect(shellKillTool.metadata.description).toBeDefined();
    });
  });

  describe('killing shells', () => {
    it('kills a running shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'sleep 30',
      });

      expect(ctx.instance.getStatus()).toBe('running');

      const result = await ctx.registry.execute(
        'shell_kill',
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGTERM',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { killed: boolean; signal: string };
        expect(data.killed).toBe(true);
        expect(data.signal).toBe('SIGTERM');
      }

      await ctx.instance.waitForExit();
      expect(ctx.instance.getStatus()).toBe('exited');
    });

    it('uses specified signal', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'sleep 30',
      });

      const result = await ctx.registry.execute(
        'shell_kill',
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGKILL',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { killed: boolean; signal: string };
        expect(data.killed).toBe(true);
        expect(data.signal).toBe('SIGKILL');
      }

      await ctx.instance.waitForExit();
      expect(ctx.instance.getStatus()).toBe('exited');
    });

    it('returns killed=false for already exited shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "done"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_kill',
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGTERM',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { killed: boolean; signal: string };
        expect(data.killed).toBe(false);
        expect(data.signal).toBe('SIGTERM');
      }
    });

    it('supports SIGINT signal', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'sleep 30',
      });

      const result = await ctx.registry.execute(
        'shell_kill',
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGINT',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { killed: boolean; signal: string };
        expect(data.killed).toBe(true);
        expect(data.signal).toBe('SIGINT');
      }

      await ctx.instance.waitForExit();
    });
  });

  describe('error handling', () => {
    it('errors for unknown shell ID', async () => {
      const result = await ctx.registry.execute(
        'shell_kill',
        {
          shellId: 'nonexistent-shell-id',
          signal: 'SIGTERM',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('nonexistent-shell-id');
      }
    });
  });
});
