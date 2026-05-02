import { describe, it, expect } from 'vitest';
import { shellGrepTool } from '../../src/tools/shell-grep.js';
import { defaultCreateOptions, mockContext, setupShellToolTest } from './shared.js';

describe('shellGrepTool', () => {
  const ctx = setupShellToolTest((mgr) => shellGrepTool(mgr));

  describe('basic matching', () => {
    it('finds matches with context', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "line1"; echo "match here"; echo "line3"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 1,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matches.length).toBe(1);
        expect(result.data.matches[0].line).toBe('match here');
        expect(result.data.matches[0].before).toContain('line1');
        expect(result.data.matches[0].after).toContain('line3');
        expect(result.data.totalMatches).toBe(1);
        expect(result.data.truncated).toBe(false);
      }
    });

    it('supports regex patterns', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "error: file not found"; echo "warning: deprecated"; echo "error: access denied"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: '^error:',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matches.length).toBe(2);
        expect(result.data.matches[0].line).toContain('file not found');
        expect(result.data.matches[1].line).toContain('access denied');
      }
    });

    it('filters by stream', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "stdout line"; echo "stderr line" >&2',
      });

      await ctx.instance.waitForExit();

      // Search only stdout
      const stdoutResult = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: 'line',
          stream: 'stdout',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(stdoutResult.success).toBe(true);
      if (stdoutResult.success) {
        expect(stdoutResult.data.matches.length).toBe(1);
        expect(stdoutResult.data.matches[0].stream).toBe('stdout');
      }

      // Search only stderr
      const stderrResult = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: 'line',
          stream: 'stderr',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(stderrResult.success).toBe(true);
      if (stderrResult.success) {
        expect(stderrResult.data.matches.length).toBe(1);
        expect(stderrResult.data.matches[0].stream).toBe('stderr');
      }
    });
  });

  describe('pagination', () => {
    it('supports pagination with offset', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "match1"; echo "match2"; echo "match3"; echo "match4"; echo "match5"',
      });

      await ctx.instance.waitForExit();

      // Get first 2 matches
      const firstPage = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 2,
          maxMatches: 2,
          offset: 0,
        },
        mockContext,
      );

      expect(firstPage.success).toBe(true);
      if (firstPage.success) {
        expect(firstPage.data.matches.length).toBe(2);
        expect(firstPage.data.matches[0].line).toBe('match1');
        expect(firstPage.data.matches[1].line).toBe('match2');
        expect(firstPage.data.totalMatches).toBe(5);
        expect(firstPage.data.truncated).toBe(true);
      }

      // Get next 2 matches
      const secondPage = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 2,
          maxMatches: 2,
          offset: 2,
        },
        mockContext,
      );

      expect(secondPage.success).toBe(true);
      if (secondPage.success) {
        expect(secondPage.data.matches.length).toBe(2);
        expect(secondPage.data.matches[0].line).toBe('match3');
        expect(secondPage.data.matches[1].line).toBe('match4');
        expect(secondPage.data.truncated).toBe(true);
      }
    });

    it('returns truncated=false when no more matches', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "match1"; echo "match2"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.truncated).toBe(false);
      }
    });
  });

  describe('error handling', () => {
    it('errors for unknown shell ID', async () => {
      const result = await ctx.tool.execute(
        {
          shellId: 'nonexistent-shell-id',
          pattern: 'test',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('nonexistent-shell-id');
      }
    });

    it('errors for invalid regex pattern', async () => {
      ctx.instance = await ctx.manager.create({
        ...defaultCreateOptions,
        command: 'echo "test"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.tool.execute(
        {
          shellId: ctx.instance.shellId,
          pattern: '[invalid(',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain('Invalid regex');
      }
    });
  });
});
