import { describe, it, expect } from 'vitest';
import { shellSendTool } from '../../src/tools/shell-send.js';
import { createDefaultCreateOptions, setupShellToolTest } from './shared.js';

describe('shellSendTool', () => {
  const ctx = setupShellToolTest();

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(shellSendTool.metadata.name).toBe('shell_send');
      expect(shellSendTool.metadata.description).toBeDefined();
    });
  });

  describe('sending input', () => {
    it('sends input to running shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'read line; echo "got: $line"',
      });

      const result = await ctx.registry.execute(
        'shell_send',
        {
          shellId: ctx.instance.shellId,
          input: 'hello world\n',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { sent: boolean; bytesWritten: number };
        expect(data.sent).toBe(true);
        expect(data.bytesWritten).toBeGreaterThan(0);
      }

      await ctx.instance.waitForExit();

      const output = ctx.instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('got: hello world');
    });

    it('returns sent=false for exited shell', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "done"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_send',
        {
          shellId: ctx.instance.shellId,
          input: 'too late\n',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { sent: boolean; bytesWritten: number };
        expect(data.sent).toBe(false);
        expect(data.bytesWritten).toBe(0);
      }
    });

    it('sends multiple inputs sequentially', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'read a; read b; echo "$a $b"',
      });

      const result1 = await ctx.registry.execute(
        'shell_send',
        {
          shellId: ctx.instance.shellId,
          input: 'first\n',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result1.success).toBe(true);
      if (result1.success) {
        const data = result1.data as { sent: boolean };
        expect(data.sent).toBe(true);
      }

      const result2 = await ctx.registry.execute(
        'shell_send',
        {
          shellId: ctx.instance.shellId,
          input: 'second\n',
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result2.success).toBe(true);
      if (result2.success) {
        const data = result2.data as { sent: boolean };
        expect(data.sent).toBe(true);
      }

      await ctx.instance.waitForExit();

      const output = ctx.instance.getOutput('stdout', 0, 10000);
      expect(output.content).toContain('first second');
    });
  });

  describe('error handling', () => {
    it('errors for unknown shell ID', async () => {
      const result = await ctx.registry.execute(
        'shell_send',
        {
          shellId: 'nonexistent-shell-id',
          input: 'test\n',
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
