import { describe, it, expect } from 'vitest';
import { shellKillTool } from '../../src/tools/shell-kill.js';
import { defaultCreateOptions, mockContext, setupShellToolTest } from './shared.js';

describe('shellKillTool', () => {
  const ctx = setupShellToolTest((mgr) => shellKillTool(mgr));

  describe('killing shells', () => {
    it('kills a running shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
      });

      expect(ctx.instance.getStatus()).toBe('running');

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGTERM',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.killed).toBe(true);
        expect(result.data.signal).toBe('SIGTERM');
      }

      await ctx.instance.waitForExit();
      expect(ctx.instance.getStatus()).toBe('exited');
    });

    it('uses specified signal', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
      });

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGKILL',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.killed).toBe(true);
        expect(result.data.signal).toBe('SIGKILL');
      }

      await ctx.instance.waitForExit();
      expect(ctx.instance.getStatus()).toBe('exited');
    });

    it('returns killed=false for already exited shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "done"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGTERM',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.killed).toBe(false);
        expect(result.data.signal).toBe('SIGTERM');
      }
    });

    it('supports SIGINT signal', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'sleep 30',
      });

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          signal: 'SIGINT',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.killed).toBe(true);
        expect(result.data.signal).toBe('SIGINT');
      }

      await ctx.instance.waitForExit();
    });
  });

  describe('error handling', () => {
    it('errors for unknown shell ID', async () => {
      const result = await ctx.tool.execute(
        {
          shellId: 'nonexistent-shell-id',
          signal: 'SIGTERM',
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('nonexistent-shell-id');
      }
    });
  });
});
