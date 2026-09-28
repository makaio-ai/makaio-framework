import { describe, expect, it } from 'vitest';
import {
  MAKAIO_TOOL_NAMES,
  NATIVE_TOOL_NAMES,
  isMakaioToolName,
  isMcpToolName,
  matchesCommandRule,
  matchesDenyCommandRule,
  parseToolListEntry,
  toMakaioToolName,
  toNativeToolName,
  toolVocabularyForAdapter,
} from '../index.js';
import type { CommandRule } from '../index.js';
import { captureToolNameError } from './tool-name-error.test-support.js';

/**
 * Expected claude column, verified against live Claude Code transcripts (2026-05-19).
 */
const claudePairs: ReadonlyArray<readonly [string, string]> = [
  ['read_file', 'Read'],
  ['write_file', 'Write'],
  ['edit_file', 'Edit'],
  ['glob_files', 'Glob'],
  ['grep_files', 'Grep'],
  ['shell_exec', 'Bash'],
  ['shell_kill', 'TaskStop'],
  ['spawn_subagent', 'Agent'],
  ['send_to_subagent', 'SendMessage'],
];

describe('MAKAIO_TOOL_NAMES / NATIVE_TOOL_NAMES', () => {
  it('lists exactly the nine Makaio framework tool names', () => {
    expect([...MAKAIO_TOOL_NAMES]).toEqual(claudePairs.map(([makaio]) => makaio));
  });

  it('has a claude entry for every Makaio tool name', () => {
    for (const [makaio, native] of claudePairs) {
      expect(NATIVE_TOOL_NAMES.claude[makaio as (typeof MAKAIO_TOOL_NAMES)[number]]).toBe(native);
    }
  });
});

describe('isMakaioToolName', () => {
  it.each(claudePairs.map(([makaio]) => makaio))('accepts %s', (name) => {
    expect(isMakaioToolName(name)).toBe(true);
  });

  it.each(['Read', 'Bash', 'WebFetch', '', 'mcp__s__t', 'READ_FILE', 'read_file '])('rejects %j', (name) => {
    expect(isMakaioToolName(name)).toBe(false);
  });
});

describe('toolVocabularyForAdapter', () => {
  it.each(['claude-code', 'claude-code-cli', 'claude-code-tmux'])('maps %s to the claude vocabulary', (adapterName) => {
    expect(toolVocabularyForAdapter(adapterName)).toBe('claude');
  });

  it('returns undefined for an adapter with no vocabulary entry', () => {
    expect(toolVocabularyForAdapter('codex-app-server')).toBeUndefined();
  });

  it.each([
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ])('returns undefined for the inherited object member %s', (adapterName) => {
    expect(toolVocabularyForAdapter(adapterName)).toBeUndefined();
  });
});

describe('isMcpToolName', () => {
  it('accepts names starting with mcp__', () => {
    expect(isMcpToolName('mcp__s__t')).toBe(true);
  });

  it('rejects built-in names', () => {
    expect(isMcpToolName('read_file')).toBe(false);
    expect(isMcpToolName('Read')).toBe(false);
    expect(isMcpToolName('mcp_s_t')).toBe(false);
  });

  it.each(['mcp__', 'mcp____tool', 'mcp__github'])('rejects %j (empty server or tool part)', (name) => {
    expect(isMcpToolName(name)).toBe(false);
  });
});

describe('toNativeToolName', () => {
  it.each(claudePairs)('maps %s to %s for claude', (makaio, native) => {
    expect(toNativeToolName('claude', makaio)).toBe(native);
  });

  it('passes MCP names through unchanged', () => {
    expect(toNativeToolName('claude', 'mcp__s__t')).toBe('mcp__s__t');
    expect(toNativeToolName('claude', 'mcp__github__create_issue')).toBe('mcp__github__create_issue');
  });

  it.each(['WebFetch', 'Read', 'Bash', 'unknown_tool'])('rejects %s with reason unknown-tool', (name) => {
    const error = captureToolNameError(() => toNativeToolName('claude', name));
    expect(error.reason).toBe('unknown-tool');
    expect(error.entry).toBe(name);
    expect(error.message).toContain(name);
  });

  it('lists the valid Makaio names in the unknown-tool message', () => {
    const error = captureToolNameError(() => toNativeToolName('claude', 'WebFetch'));
    for (const makaio of MAKAIO_TOOL_NAMES) {
      expect(error.message).toContain(makaio);
    }
  });

  it('names the full list entry on the error, not just the bare tool name', () => {
    const error = captureToolNameError(() => toNativeToolName('claude', 'WebFetch', 'WebFetch(git status)'));
    expect(error.entry).toBe('WebFetch(git status)');
    expect(error.message).toContain('WebFetch(git status)');
  });

  it('defaults the error entry to the name when no entry is given', () => {
    const error = captureToolNameError(() => toNativeToolName('claude', 'WebFetch'));
    expect(error.entry).toBe('WebFetch');
  });

  it('produces an Error subclass', () => {
    const error = captureToolNameError(() => toNativeToolName('claude', 'Read'));
    expect(error).toBeInstanceOf(Error);
  });
});

describe('toMakaioToolName', () => {
  it.each(claudePairs)('maps claude %s back from %s', (makaio, native) => {
    expect(toMakaioToolName('claude', native)).toBe(makaio);
  });

  it('passes MCP names through unchanged', () => {
    expect(toMakaioToolName('claude', 'mcp__s__t')).toBe('mcp__s__t');
  });

  it('returns undefined for native names without a Makaio name', () => {
    expect(toMakaioToolName('claude', 'WebFetch')).toBeUndefined();
    expect(toMakaioToolName('claude', 'TodoWrite')).toBeUndefined();
  });

  it('does not treat Makaio names as native names', () => {
    expect(toMakaioToolName('claude', 'read_file')).toBeUndefined();
  });

  it('round-trips every Makaio name through the claude vocabulary', () => {
    for (const makaio of MAKAIO_TOOL_NAMES) {
      expect(toMakaioToolName('claude', toNativeToolName('claude', makaio))).toBe(makaio);
    }
  });
});

describe('parseToolListEntry', () => {
  it('parses a plain Makaio name without a rule', () => {
    const parsed = parseToolListEntry('read_file');
    expect(parsed.name).toBe('read_file');
    expect(parsed.rule).toBeUndefined();
  });

  it('parses an MCP name without a rule', () => {
    const parsed = parseToolListEntry('mcp__s__t');
    expect(parsed.name).toBe('mcp__s__t');
    expect(parsed.rule).toBeUndefined();
  });

  it('does not validate the name against the Makaio list', () => {
    const parsed = parseToolListEntry('Read');
    expect(parsed.name).toBe('Read');
    expect(parsed.rule).toBeUndefined();
  });

  it('parses an exact command rule', () => {
    const parsed = parseToolListEntry('shell_exec(git status)');
    expect(parsed.name).toBe('shell_exec');
    expect(parsed.rule).toEqual({ kind: 'exact', command: 'git status' });
  });

  it('trims an exact command rule', () => {
    const parsed = parseToolListEntry('shell_exec(   git status  )');
    expect(parsed.name).toBe('shell_exec');
    expect(parsed.rule).toEqual({ kind: 'exact', command: 'git status' });
  });

  it('parses a prefix command rule', () => {
    const parsed = parseToolListEntry('shell_exec(git log:*)');
    expect(parsed.name).toBe('shell_exec');
    expect(parsed.rule).toEqual({ kind: 'prefix', prefix: 'git log' });
  });

  it('normalizes blank runs in a prefix rule', () => {
    const parsed = parseToolListEntry('shell_exec(git  log :*)');
    expect(parsed.name).toBe('shell_exec');
    expect(parsed.rule).toEqual({ kind: 'prefix', prefix: 'git log' });
  });

  it.each([
    'shell_exec(',
    'shell_exec()',
    '(x)',
    'shell_exec(a)b',
    'mcp__',
    'mcp____tool',
    'mcp__github',
    'mcp__s__*',
    'shell_exec(rm *)',
    'shell_exec(npm run *)',
    'shell_exec(*)',
  ])('rejects %j with reason malformed-entry', (entry) => {
    const error = captureToolNameError(() => parseToolListEntry(entry));
    expect(error.reason).toBe('malformed-entry');
    expect(error.entry).toBe(entry);
    expect(error.message).toContain(entry);
  });
});

describe('matchesCommandRule', () => {
  describe('exact rule', () => {
    const rule: CommandRule = { kind: 'exact', command: 'git status' };

    it('matches an equal command', () => {
      expect(matchesCommandRule(rule, 'git status')).toBe(true);
    });

    it('does not match a different command', () => {
      expect(matchesCommandRule(rule, 'git stash')).toBe(false);
      expect(matchesCommandRule(rule, 'git status --short')).toBe(false);
      expect(matchesCommandRule(rule, 'git')).toBe(false);
    });

    it('trims the command before comparing', () => {
      expect(matchesCommandRule(rule, '  git status  ')).toBe(true);
      expect(matchesCommandRule(rule, '\tgit status\n')).toBe(true);
    });
  });

  describe('prefix rule', () => {
    const rule: CommandRule = { kind: 'prefix', prefix: 'git log' };

    it('matches the prefix itself', () => {
      expect(matchesCommandRule(rule, 'git log')).toBe(true);
    });

    it('matches the prefix followed by arguments', () => {
      expect(matchesCommandRule(rule, 'git log --oneline -n 5')).toBe(true);
    });

    it('trims the command before comparing', () => {
      expect(matchesCommandRule(rule, '  git log --oneline  ')).toBe(true);
    });

    it('does not match a longer word sharing the prefix', () => {
      expect(matchesCommandRule(rule, 'git logx')).toBe(false);
    });

    it('does not match an unrelated command', () => {
      expect(matchesCommandRule(rule, 'git status')).toBe(false);
      expect(matchesCommandRule(rule, 'git')).toBe(false);
    });

    it.each([
      ['&&', 'git log && rm -rf /'],
      ['||', 'git log || rm -rf /'],
      [';', 'git log; rm -rf /'],
      ['|', 'git log | sh'],
      ['backtick', 'git log `rm -rf /`'],
      ['$(', 'git log $(rm -rf /)'],
      ['>', 'git log > out.txt'],
      ['<', 'git log < in.txt'],
      ['newline', 'git log\nrm -rf /'],
      ['lone &', 'git log --oneline &'],
      ['${', 'git log ${X}'],
      ['{ }', 'git log {a,b}'],
      ['( )', 'git log (arg)'],
      ['carriage return', 'git log\rrm -rf /'],
    ])('never matches when the command contains %s', (_operator, command) => {
      expect(matchesCommandRule(rule, command)).toBe(false);
    });
  });
});

describe('matchesDenyCommandRule', () => {
  describe('prefix rule', () => {
    const rule: CommandRule = { kind: 'prefix', prefix: 'git push' };

    it('matches the bare command', () => {
      expect(matchesDenyCommandRule(rule, 'git push')).toBe(true);
    });

    it('matches the prefix followed by arguments', () => {
      expect(matchesDenyCommandRule(rule, 'git push origin')).toBe(true);
    });

    it.each([
      ['extra blanks between words', 'git   push  origin'],
      ['a tab between words', 'git\tpush'],
    ])('normalizes %s before comparing', (_label, command) => {
      expect(matchesDenyCommandRule(rule, command)).toBe(true);
    });

    it.each([
      [';', 'true; git push'],
      ['&&', 'x && git push'],
      ['single &', 'x & git push'],
      ['|', 'x | git push'],
      ['newline', 'x\ngit push'],
      ['CRLF', 'x\r\ngit push'],
      ['$(...)', '$(git push)'],
      ['backticks', '`git push`'],
      ['{ ; }', '{ git push; }'],
      ['(...)', '(git push)'],
      ['redirection', 'git push >out'],
    ])('matches the segment split on %s', (_label, command) => {
      expect(matchesDenyCommandRule(rule, command)).toBe(true);
    });

    it('matches across a backslash-newline continuation, removed before splitting', () => {
      expect(matchesDenyCommandRule(rule, 'git \\\npush')).toBe(true);
    });

    it('does not match a longer word sharing the prefix', () => {
      expect(matchesDenyCommandRule(rule, 'git pushx')).toBe(false);
    });

    it('does not match a segment where the prefix is not at the start', () => {
      expect(matchesDenyCommandRule(rule, 'echo git push')).toBe(false);
    });
  });

  describe('exact rule', () => {
    const rule: CommandRule = { kind: 'exact', command: 'rm -rf /' };

    it('matches an exact segment among chained commands', () => {
      expect(matchesDenyCommandRule(rule, 'ls; rm -rf / ; echo done')).toBe(true);
    });

    it('does not match a segment that only shares the exact command as a prefix', () => {
      expect(matchesDenyCommandRule(rule, 'ls; rm -rf /tmp/x')).toBe(false);
    });
  });
});
