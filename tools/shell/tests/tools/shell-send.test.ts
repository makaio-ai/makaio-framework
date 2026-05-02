import { describe, it, expect } from 'vitest';
import { shellSendTool } from '../../src/tools/shell-send.js';
import { defaultCreateOptions, mockContext, setupShellToolTest } from './shared.js';

describe('shellSendTool', () => {
  const ctx = setupShellToolTest((mgr) => shellSendTool(mgr));

  describe('sending input', () => {
    it('sends input to running shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'read line; echo "got: $line"',
      });

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          input: 'hello world\n',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sent).toBe(true);
        expect(result.data.bytesWritten).toBeGreaterThan(0);
      }

      await ctx.instance.waitForExit();

      const output = ctx.instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('got: hello world');
    });

    it('returns sent=false for exited shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "done"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          input: 'too late\n',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sent).toBe(false);
        expect(result.data.bytesWritten).toBe(0);
      }
    });

    it('sends multiple inputs sequentially', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'read a; read b; echo "$a $b"',
      });

      const result1 = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          input: 'first\n',
        },
        mockContext,
      );

      expect(result1.success).toBe(true);
      if (result1.success) {
        expect(result1.data.sent).toBe(true);
      }

      const result2 = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          input: 'second\n',
        },
        mockContext,
      );

      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.data.sent).toBe(true);
      }

      await ctx.instance.waitForExit();

      const output = ctx.instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('first second');
    });
  });

  describe('error handling', () => {
    it('errors for unknown shell ID', async () => {
      const result = await ctx.tool.execute(
        {
          shellId: 'nonexistent-shell-id',
          input: 'test\n',
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
