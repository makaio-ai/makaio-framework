import { describe, it, expect, vi } from 'vitest';
import { shellOutputTool } from '../../src/tools/shell-output.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import { setupShellManagerTest } from './shared.js';

describe('shellOutputTool', () => {
  const ctx = setupShellManagerTest((mgr) => shellOutputTool(mgr));

  // Default input values matching Zod schema defaults
  const defaultInput = {
    stream: 'both' as const,
    offset: 0,
    limit: 10000,
  };

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(ctx.tool.metadata.name).toBe('shell_output');
      expect(ctx.tool.metadata.description).toContain('output');
    });

    it('has readOnly annotation', () => {
      expect(ctx.tool.metadata.annotations?.readOnly).toBe(true);
    });
  });

  describe('execute', () => {
    it('returns stdout content', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "hello world"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.tool.execute(
        { ...defaultInput, shellId: instance.shellId, stream: 'stdout' },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toContain('hello world');
        expect(result.data.stream).toBe('stdout');
        expect(result.data.offset).toBe(0);
        expect(result.data.totalSize).toBeGreaterThan(0);
      }
    });

    it('returns stderr content', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "error message" >&2',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.tool.execute(
        { ...defaultInput, shellId: instance.shellId, stream: 'stderr' },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toContain('error message');
        expect(result.data.stream).toBe('stderr');
      }
    });

    it('returns interleaved content for both streams', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "stdout"; echo "stderr" >&2',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.tool.execute(
        { ...defaultInput, shellId: instance.shellId, stream: 'both' },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toContain('stdout');
        expect(result.data.content).toContain('stderr');
        expect(result.data.stream).toBe('interleaved');
      }
    });

    it('uses stream=both as default', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "output"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      // Using 'both' explicitly since tool.execute expects validated input
      const result = await ctx.tool.execute({ ...defaultInput, shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stream).toBe('interleaved');
      }
    });

    it('supports pagination with offset', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "0123456789"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      // Get full output first to know total size
      const fullResult = await ctx.tool.execute(
        { shellId: instance.shellId, stream: 'stdout', offset: 0, limit: 1000 },
        ctx.context,
      );

      expect(fullResult.success).toBe(true);
      if (!fullResult.success) return;

      const totalSize = fullResult.data.totalSize;

      // Get with offset
      const offsetResult = await ctx.tool.execute(
        { shellId: instance.shellId, stream: 'stdout', offset: 5, limit: 10000 },
        ctx.context,
      );

      expect(offsetResult.success).toBe(true);
      if (offsetResult.success) {
        expect(offsetResult.data.offset).toBe(5);
        expect(offsetResult.data.totalSize).toBe(totalSize);
        // Content should start from position 5
        expect(offsetResult.data.content).toBe(fullResult.data.content.slice(5));
      }
    });

    it('supports pagination with limit', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "0123456789"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.tool.execute(
        { shellId: instance.shellId, stream: 'stdout', offset: 0, limit: 5 },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content.length).toBe(5);
        expect(result.data.hasMore).toBe(true);
      }
    });

    it('indicates hasMore=false when all content retrieved', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "short"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.tool.execute({ ...defaultInput, shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hasMore).toBe(false);
      }
    });

    it('returns empty content when offset exceeds total size', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "short"',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      await instance.waitForExit();

      const result = await ctx.tool.execute(
        { shellId: instance.shellId, stream: 'both', offset: 10000, limit: 10000 },
        ctx.context,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toBe('');
        expect(result.data.hasMore).toBe(false);
      }
    });

    it('errors for unknown shell ID', async () => {
      const result = await ctx.tool.execute({ ...defaultInput, shellId: 'nonexistent-id' }, ctx.context);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('Shell not found');
        expect(result.error.message).toContain('nonexistent-id');
      }
    });

    it('works with running shell (partial output)', async () => {
      const instance = await ctx.manager.create({
        command: 'echo "immediate output"; sleep 10',
        cwd: process.cwd(),
        env: {},
        platform: 'posix',
        colors: false,
        constraints: DEFAULT_CONSTRAINTS,
      });

      // Wait for output to appear in buffer (condition-based, not arbitrary timeout)
      await vi.waitFor(() => {
        const output = instance.getOutput('stdout', 0, 10000);
        if (!output.content.includes('immediate output')) {
          throw new Error('Output not yet available');
        }
      });

      const result = await ctx.tool.execute({ ...defaultInput, shellId: instance.shellId }, ctx.context);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toContain('immediate output');
      }

      // Cleanup
      await instance.kill();
      await instance.waitForExit();
    });
  });
});
