import { describe, it, expect } from 'vitest';
import { shellGrepTool } from '../../src/tools/shell-grep.js';
import { createDefaultCreateOptions, setupShellToolTest } from './shared.js';

describe('shellGrepTool', () => {
  const ctx = setupShellToolTest();

  describe('metadata', () => {
    it('has correct name and description', () => {
      expect(shellGrepTool.metadata.name).toBe('shell_grep');
      expect(shellGrepTool.metadata.description).toContain('regex');
    });

    it('has readOnly annotation', () => {
      expect(shellGrepTool.metadata.annotations?.readOnly).toBe(true);
    });
  });

  describe('basic matching', () => {
    it('finds matches with context', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "line1"; echo "match here"; echo "line3"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 1,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          matches: Array<{ line: string; before: string[]; after: string[] }>;
          totalMatches: number;
          truncated: boolean;
        };
        expect(data.matches.length).toBe(1);
        expect(data.matches[0].line).toBe('match here');
        expect(data.matches[0].before).toContain('line1');
        expect(data.matches[0].after).toContain('line3');
        expect(data.totalMatches).toBe(1);
        expect(data.truncated).toBe(false);
      }
    });

    it('supports regex patterns', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "error: file not found"; echo "warning: deprecated"; echo "error: access denied"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: '^error:',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          matches: Array<{ line: string }>;
        };
        expect(data.matches.length).toBe(2);
        expect(data.matches[0].line).toContain('file not found');
        expect(data.matches[1].line).toContain('access denied');
      }
    });

    it('filters by stream', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "stdout line"; echo "stderr line" >&2',
      });

      await ctx.instance.waitForExit();

      // Search only stdout
      const stdoutResult = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: 'line',
          stream: 'stdout',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(stdoutResult.success).toBe(true);
      if (stdoutResult.success) {
        const data = stdoutResult.data as {
          matches: Array<{ stream: string }>;
        };
        expect(data.matches.length).toBe(1);
        expect(data.matches[0].stream).toBe('stdout');
      }

      // Search only stderr
      const stderrResult = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: 'line',
          stream: 'stderr',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(stderrResult.success).toBe(true);
      if (stderrResult.success) {
        const data = stderrResult.data as {
          matches: Array<{ stream: string }>;
        };
        expect(data.matches.length).toBe(1);
        expect(data.matches[0].stream).toBe('stderr');
      }
    });
  });

  describe('pagination', () => {
    it('supports pagination with offset', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "match1"; echo "match2"; echo "match3"; echo "match4"; echo "match5"',
      });

      await ctx.instance.waitForExit();

      // Get first 2 matches
      const firstPage = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 2,
          maxMatches: 2,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(firstPage.success).toBe(true);
      if (firstPage.success) {
        const data = firstPage.data as {
          matches: Array<{ line: string }>;
          totalMatches: number;
          truncated: boolean;
        };
        expect(data.matches.length).toBe(2);
        expect(data.matches[0].line).toBe('match1');
        expect(data.matches[1].line).toBe('match2');
        expect(data.totalMatches).toBe(5);
        expect(data.truncated).toBe(true);
      }

      // Get next 2 matches
      const secondPage = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 2,
          maxMatches: 2,
          offset: 2,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(secondPage.success).toBe(true);
      if (secondPage.success) {
        const data = secondPage.data as {
          matches: Array<{ line: string }>;
          truncated: boolean;
        };
        expect(data.matches.length).toBe(2);
        expect(data.matches[0].line).toBe('match3');
        expect(data.matches[1].line).toBe('match4');
        expect(data.truncated).toBe(true);
      }
    });

    it('returns truncated=false when no more matches', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "match1"; echo "match2"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: 'match',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { truncated: boolean };
        expect(data.truncated).toBe(false);
      }
    });
  });

  describe('error handling', () => {
    it('errors for unknown shell ID', async () => {
      const result = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: 'nonexistent-shell-id',
          pattern: 'test',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(result.error.message).toContain('nonexistent-shell-id');
      }
    });

    it('errors for invalid regex pattern', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "test"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: '[invalid(',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain('Invalid regex');
      }
    });

    it('rejects regex patterns with catastrophic backtracking risk', async () => {
      ctx.instance = await ctx.manager.create({
        ...createDefaultCreateOptions(),
        command: 'echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      });

      await ctx.instance.waitForExit();

      const result = await ctx.registry.execute(
        'shell_grep',
        {
          shellId: ctx.instance.shellId,
          pattern: '(a+)+$',
          stream: 'both',
          context: 2,
          maxMatches: 10,
          offset: 0,
        },
        { contextOverrides: { constraints: {} } },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain('Unsafe regex');
      }
    });
  });
});
