import { describe, expect, it } from 'vitest';
import { resolveToolPolicy, ToolNameError } from '../index.js';
import type { ToolLists, ToolNameErrorReason } from '../index.js';

const NOT_ON_ALLOWLIST = (nativeName: string): string => `Tool ${nativeName} is not on the step's allowlist`;

/**
 * Resolve the given lists and capture the thrown ToolNameError.
 * @param lists - Tool lists passed to resolveToolPolicy
 * @returns The thrown ToolNameError
 */
function captureToolNameError(lists: ToolLists): ToolNameError {
  try {
    resolveToolPolicy('claude', lists);
  } catch (error) {
    expect(error).toBeInstanceOf(ToolNameError);
    return error as ToolNameError;
  }
  throw new Error('expected resolveToolPolicy to throw a ToolNameError');
}

describe('resolveToolPolicy', () => {
  describe('no lists', () => {
    it('leaves every translated field undefined', () => {
      const policy = resolveToolPolicy('claude', {});
      expect(policy.nativeAvailableTools).toBeUndefined();
      expect(policy.nativeAllowedEntries).toBeUndefined();
      expect(policy.nativeDisallowedTools).toBeUndefined();
    });

    it('allows every call, including MCP tools and native names without a Makaio name', () => {
      const policy = resolveToolPolicy('claude', {});
      expect(policy.checkToolCall('Read', { file_path: '/tmp/x' })).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', { command: 'git push' })).toEqual({ allowed: true });
      expect(policy.checkToolCall('mcp__s__t', {})).toEqual({ allowed: true });
      expect(policy.checkToolCall('WebFetch', { url: 'https://example.com' })).toEqual({ allowed: true });
    });
  });

  describe('plain allowlist', () => {
    it('translates Makaio names to native available tools and entries', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['read_file', 'edit_file'] });
      expect(policy.nativeAvailableTools).toEqual(['Read', 'Edit']);
      expect(policy.nativeAllowedEntries).toEqual(['Read', 'Edit']);
      expect(policy.nativeDisallowedTools).toBeUndefined();
    });

    it('allows listed tools and denies unlisted ones with the allowlist reason', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['read_file', 'edit_file'] });
      expect(policy.checkToolCall('Read', {})).toEqual({ allowed: true });
      expect(policy.checkToolCall('Edit', {})).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', { command: 'ls' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
      expect(policy.checkToolCall('Write', {})).toEqual({ allowed: false, reason: NOT_ON_ALLOWLIST('Write') });
    });

    it('translates every Makaio tool name to its Claude name', () => {
      const policy = resolveToolPolicy('claude', {
        allowedTools: [
          'read_file',
          'write_file',
          'edit_file',
          'glob_files',
          'grep_files',
          'shell_exec',
          'shell_kill',
          'spawn_subagent',
          'send_to_subagent',
        ],
      });
      expect(policy.nativeAvailableTools).toEqual([
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'TaskStop',
        'Agent',
        'SendMessage',
      ]);
    });
  });

  describe('empty allowlist', () => {
    it('yields empty native lists', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: [] });
      expect(policy.nativeAvailableTools).toEqual([]);
      expect(policy.nativeAllowedEntries).toEqual([]);
      expect(policy.nativeDisallowedTools).toBeUndefined();
    });

    it('denies every tool including MCP tools', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: [] });
      expect(policy.checkToolCall('Read', {})).toEqual({ allowed: false, reason: NOT_ON_ALLOWLIST('Read') });
      expect(policy.checkToolCall('mcp__s__t', {})).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('mcp__s__t'),
      });
    });
  });

  describe('MCP entries', () => {
    it('keeps MCP names in allowed entries but excludes them from available tools', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['read_file', 'mcp__s__t'] });
      expect(policy.nativeAvailableTools).toEqual(['Read']);
      expect(policy.nativeAllowedEntries).toEqual(['Read', 'mcp__s__t']);
    });

    it('allows the listed MCP tool and denies other MCP tools', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['mcp__s__t'] });
      expect(policy.nativeAvailableTools).toEqual([]);
      expect(policy.checkToolCall('mcp__s__t', {})).toEqual({ allowed: true });
      expect(policy.checkToolCall('mcp__s__other', {})).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('mcp__s__other'),
      });
      expect(policy.checkToolCall('Read', {})).toEqual({ allowed: false, reason: NOT_ON_ALLOWLIST('Read') });
    });

    it('denies an MCP tool on the denylist', () => {
      const policy = resolveToolPolicy('claude', { disallowedTools: ['mcp__s__t'] });
      expect(policy.nativeDisallowedTools).toEqual(['mcp__s__t']);
      expect(policy.checkToolCall('mcp__s__t', {}).allowed).toBe(false);
      expect(policy.checkToolCall('mcp__s__other', {})).toEqual({ allowed: true });
    });
  });

  describe('command rules on the allowlist', () => {
    it('dedupes the base name in available tools while keeping every entry', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec', 'shell_exec(git status)'] });
      expect(policy.nativeAvailableTools).toEqual(['Bash']);
      expect(policy.nativeAllowedEntries).toEqual(['Bash', 'Bash(git status)']);
    });

    it('renders an exact rule as a native entry', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git status)'] });
      expect(policy.nativeAvailableTools).toEqual(['Bash']);
      expect(policy.nativeAllowedEntries).toEqual(['Bash(git status)']);
    });

    it('renders a prefix rule as a native entry', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git log:*)'] });
      expect(policy.nativeAvailableTools).toEqual(['Bash']);
      expect(policy.nativeAllowedEntries).toEqual(['Bash(git log:*)']);
    });

    it('trims the rule text before rendering', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec( git status )'] });
      expect(policy.nativeAllowedEntries).toEqual(['Bash(git status)']);
    });

    it('exact rule allows only the exact command', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git status)'] });
      expect(policy.checkToolCall('Bash', { command: 'git status' })).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', { command: 'git push' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
    });

    it('exact rule denies a command with a trailing chained command', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git status)'] });
      expect(policy.checkToolCall('Bash', { command: 'git status\nrm' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
    });

    it('exact rule denies a missing or non-string command', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git status)'] });
      expect(policy.checkToolCall('Bash', {})).toEqual({ allowed: false, reason: NOT_ON_ALLOWLIST('Bash') });
      expect(policy.checkToolCall('Bash', { command: 42 })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
      expect(policy.checkToolCall('Bash', { command: ['git', 'status'] })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
    });

    it('prefix rule allows the prefix and its argument forms', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git log:*)'] });
      expect(policy.checkToolCall('Bash', { command: 'git log' })).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', { command: 'git log --oneline' })).toEqual({ allowed: true });
    });

    it('prefix rule denies chained commands and non-word-boundary matches', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec(git log:*)'] });
      expect(policy.checkToolCall('Bash', { command: 'git log && rm -rf /' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
      expect(policy.checkToolCall('Bash', { command: 'git log & rm -rf /' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
      expect(policy.checkToolCall('Bash', { command: 'git log; rm -rf /' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
      expect(policy.checkToolCall('Bash', { command: 'git logx' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
      expect(policy.checkToolCall('Bash', { command: 'git status' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('Bash'),
      });
    });

    it('a plain entry allows any command regardless of rule entries', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['shell_exec', 'shell_exec(git status)'] });
      expect(policy.checkToolCall('Bash', { command: 'git push' })).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', {})).toEqual({ allowed: true });
    });
  });

  describe('denylist', () => {
    it('plain deny beats plain allow', () => {
      const policy = resolveToolPolicy('claude', {
        allowedTools: ['shell_exec', 'read_file'],
        disallowedTools: ['shell_exec'],
      });
      expect(policy.checkToolCall('Bash', { command: 'ls' }).allowed).toBe(false);
      expect(policy.checkToolCall('Read', {})).toEqual({ allowed: true });
    });

    it('rule deny beats plain allow only for matching commands', () => {
      const policy = resolveToolPolicy('claude', {
        allowedTools: ['shell_exec'],
        disallowedTools: ['shell_exec(rm -rf:*)'],
      });
      const denied = policy.checkToolCall('Bash', { command: 'rm -rf /tmp/x' });
      expect(denied.allowed).toBe(false);
      expect(policy.checkToolCall('Bash', { command: 'ls -la' })).toEqual({ allowed: true });
    });

    it('rule deny beats a matching rule allow', () => {
      const policy = resolveToolPolicy('claude', {
        allowedTools: ['shell_exec(git status)'],
        disallowedTools: ['shell_exec(git status)'],
      });
      expect(policy.checkToolCall('Bash', { command: 'git status' }).allowed).toBe(false);
    });

    it('a rule deny never matches a missing or non-string command', () => {
      const policy = resolveToolPolicy('claude', { disallowedTools: ['shell_exec(rm -rf:*)'] });
      expect(policy.checkToolCall('Bash', {})).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', { command: 7 })).toEqual({ allowed: true });
    });

    it('denylist-only denies exactly the listed tools and allows the rest', () => {
      const policy = resolveToolPolicy('claude', { disallowedTools: ['write_file', 'edit_file'] });
      expect(policy.nativeAvailableTools).toBeUndefined();
      expect(policy.nativeAllowedEntries).toBeUndefined();
      expect(policy.checkToolCall('Write', {}).allowed).toBe(false);
      expect(policy.checkToolCall('Edit', {}).allowed).toBe(false);
      expect(policy.checkToolCall('Read', {})).toEqual({ allowed: true });
      expect(policy.checkToolCall('Bash', { command: 'ls' })).toEqual({ allowed: true });
      expect(policy.checkToolCall('mcp__s__t', {})).toEqual({ allowed: true });
    });

    it('deny decisions carry a non-empty reason', () => {
      const policy = resolveToolPolicy('claude', { disallowedTools: ['write_file'] });
      const decision = policy.checkToolCall('Write', {});
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(typeof decision.reason).toBe('string');
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });

    it('translates the denylist to native entries with rules kept', () => {
      const policy = resolveToolPolicy('claude', {
        disallowedTools: ['shell_exec(rm -rf:*)', 'write_file', 'shell_exec(git push)'],
      });
      expect(policy.nativeDisallowedTools).toEqual(['Bash(rm -rf:*)', 'Write', 'Bash(git push)']);
    });

    it('an empty denylist is translated to an empty list and denies nothing', () => {
      const policy = resolveToolPolicy('claude', { disallowedTools: [] });
      expect(policy.nativeDisallowedTools).toEqual([]);
      expect(policy.checkToolCall('Bash', { command: 'rm -rf /' })).toEqual({ allowed: true });
    });

    it('a deny prefix rule denies chained forms of the denied command, alongside a plain allow', () => {
      const policy = resolveToolPolicy('claude', {
        allowedTools: ['shell_exec'],
        disallowedTools: ['shell_exec(git push:*)'],
      });
      for (const command of [
        'git push',
        'true; git push',
        'x && git push',
        'x & git push',
        'x | git push',
        'x\ngit push',
        'x\r\ngit push',
        '$(git push)',
        '`git push`',
        '{ git push; }',
        '(git push)',
        'git push >out',
        'git\tpush',
      ]) {
        expect(policy.checkToolCall('Bash', { command }).allowed).toBe(false);
      }
      expect(policy.checkToolCall('Bash', { command: 'git status' })).toEqual({ allowed: true });
    });
  });

  describe('native names without a Makaio name', () => {
    it('are denied when an allowlist exists', () => {
      const policy = resolveToolPolicy('claude', { allowedTools: ['read_file'] });
      expect(policy.checkToolCall('WebFetch', { url: 'https://example.com' })).toEqual({
        allowed: false,
        reason: NOT_ON_ALLOWLIST('WebFetch'),
      });
    });

    it('are allowed when no allowlist exists', () => {
      const policy = resolveToolPolicy('claude', { disallowedTools: ['read_file'] });
      expect(policy.checkToolCall('WebFetch', { url: 'https://example.com' })).toEqual({ allowed: true });
    });
  });

  describe('validation errors', () => {
    const cases: readonly { entry: string; reason: ToolNameErrorReason }[] = [
      { entry: 'Read', reason: 'unknown-tool' },
      { entry: 'WebFetch', reason: 'unknown-tool' },
      { entry: 'read_file(x)', reason: 'rule-not-supported' },
      { entry: 'shell_exec(', reason: 'malformed-entry' },
    ];

    for (const listKey of ['allowedTools', 'disallowedTools'] as const) {
      for (const { entry, reason } of cases) {
        it(`${listKey}: '${entry}' throws ToolNameError '${reason}'`, () => {
          const error = captureToolNameError({ [listKey]: [entry] });
          expect(error.reason).toBe(reason);
          expect(error.entry).toBe(entry);
          expect(error.message).toContain(entry);
        });
      }
    }

    it('validates eagerly even when the bad entry follows valid ones', () => {
      const error = captureToolNameError({ allowedTools: ['read_file', 'shell_exec(git status)', 'Bash'] });
      expect(error.reason).toBe('unknown-tool');
      expect(error.entry).toBe('Bash');
    });

    it('unknown-tool messages list the valid Makaio names', () => {
      const error = captureToolNameError({ allowedTools: ['Read'] });
      expect(error.message).toContain('read_file');
      expect(error.message).toContain('shell_exec');
    });
  });
});
