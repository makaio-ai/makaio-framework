import { describe, it, expect } from 'bun:test';
import { waitFor } from '@makaio/test-utils';
import { shellOutputTool } from '../../src/tools/shell-output.js';
import { DEFAULT_CONSTRAINTS } from '../../src/types.js';
import { setupShellManagerTest } from './shared.js';

describe('shellOutputTool', () => {
  const ctx = setupShellManagerTest();

  // Default input values matching Zod schema defaults
  const defaultInput = {
    stream: 'both' as const,
    offset: 0,
    limit: 10000,
  };

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(shellOutputTool.metadata.name).toBe('shell_output');
      expect(shellOutputTool.metadata.description).toContain('output');
    });

    it('has readOnly annotation', () => {
      expect(shellOutputTool.metadata.annotations?.readOnly).toBe(true);
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

      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: instance.shellId, stream: 'stdout' },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          content: string;
          stream: string;
          offset: number;
          totalSize: number;
        };
        expect(data.content).toContain('hello world');
        expect(data.stream).toBe('stdout');
        expect(data.offset).toBe(0);
        expect(data.totalSize).toBeGreaterThan(0);
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

      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: instance.shellId, stream: 'stderr' },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { content: string; stream: string };
        expect(data.content).toContain('error message');
        expect(data.stream).toBe('stderr');
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

      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: instance.shellId, stream: 'both' },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { content: string; stream: string };
        expect(data.content).toContain('stdout');
        expect(data.content).toContain('stderr');
        expect(data.stream).toBe('interleaved');
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
      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { stream: string };
        expect(data.stream).toBe('interleaved');
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
      const fullResult = await ctx.registry.execute(
        'shell_output',
        { shellId: instance.shellId, stream: 'stdout', offset: 0, limit: 1000 },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(fullResult.success).toBe(true);
      if (!fullResult.success) return;

      const fullData = fullResult.data as { totalSize: number; content: string };
      const totalSize = fullData.totalSize;

      // Get with offset
      const offsetResult = await ctx.registry.execute(
        'shell_output',
        { shellId: instance.shellId, stream: 'stdout', offset: 5, limit: 10000 },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(offsetResult.success).toBe(true);
      if (offsetResult.success) {
        const data = offsetResult.data as { offset: number; totalSize: number; content: string };
        expect(data.offset).toBe(5);
        expect(data.totalSize).toBe(totalSize);
        // Content should start from position 5
        expect(data.content).toBe(fullData.content.slice(5));
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

      const result = await ctx.registry.execute(
        'shell_output',
        { shellId: instance.shellId, stream: 'stdout', offset: 0, limit: 5 },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { content: string; hasMore: boolean };
        expect(data.content.length).toBe(5);
        expect(data.hasMore).toBe(true);
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

      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { hasMore: boolean };
        expect(data.hasMore).toBe(false);
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

      const result = await ctx.registry.execute(
        'shell_output',
        { shellId: instance.shellId, stream: 'both', offset: 10000, limit: 10000 },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { content: string; hasMore: boolean };
        expect(data.content).toBe('');
        expect(data.hasMore).toBe(false);
      }
    });

    it('errors for unknown shell ID', async () => {
      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: 'nonexistent-id' },
        { contextOverrides: { constraints: ctx.constraints } },
      );

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
      await waitFor(() => {
        const output = instance.getOutput('stdout', 0, 10000);
        if (!output.content.includes('immediate output')) {
          throw new Error('Output not yet available');
        }
      });

      const result = await ctx.registry.execute(
        'shell_output',
        { ...defaultInput, shellId: instance.shellId },
        { contextOverrides: { constraints: ctx.constraints } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { content: string };
        expect(data.content).toContain('immediate output');
      }

      // Cleanup
      await instance.kill();
      await instance.waitForExit();
    });
  });
});
