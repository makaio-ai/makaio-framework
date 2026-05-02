import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeConfigSchemas,
  ClaudeCodeHookDefinitionSchema,
  ClaudeCodeHookMatcherGroupSchema,
  ClaudeCodeScopeSchema,
  ClaudeCodeStatuslineValueSchema,
} from '../config.js';

// ---------------------------------------------------------------------------
// ClaudeCodeScopeSchema
// ---------------------------------------------------------------------------

describe('ClaudeCodeScopeSchema', () => {
  it('accepts all three valid scope values', () => {
    expect(ClaudeCodeScopeSchema.parse('user')).toBe('user');
    expect(ClaudeCodeScopeSchema.parse('project')).toBe('project');
    expect(ClaudeCodeScopeSchema.parse('local')).toBe('local');
  });

  it('rejects the managed scope (not supported in v1)', () => {
    expect(ClaudeCodeScopeSchema.safeParse('managed').success).toBe(false);
  });

  it('rejects unknown scope strings', () => {
    expect(ClaudeCodeScopeSchema.safeParse('global').success).toBe(false);
    expect(ClaudeCodeScopeSchema.safeParse('').success).toBe(false);
    expect(ClaudeCodeScopeSchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeStatuslineValueSchema
// ---------------------------------------------------------------------------

describe('ClaudeCodeStatuslineValueSchema', () => {
  it('accepts a minimal valid statusline command', () => {
    const result = ClaudeCodeStatuslineValueSchema.parse({
      type: 'command',
      command: 'my-statusline-cmd',
    });
    expect(result.type).toBe('command');
    expect(result.command).toBe('my-statusline-cmd');
    expect(result.padding).toBeUndefined();
  });

  it('accepts a statusline command with optional padding', () => {
    const result = ClaudeCodeStatuslineValueSchema.parse({
      type: 'command',
      command: 'my-statusline-cmd',
      padding: 2,
    });
    expect(result.padding).toBe(2);
  });

  it('requires the type literal to be exactly "command"', () => {
    expect(
      ClaudeCodeStatuslineValueSchema.safeParse({
        type: 'script',
        command: 'my-cmd',
      }).success,
    ).toBe(false);
  });

  it('rejects a value missing the command field', () => {
    expect(
      ClaudeCodeStatuslineValueSchema.safeParse({
        type: 'command',
      }).success,
    ).toBe(false);
  });

  it('rejects a value missing the type field', () => {
    expect(
      ClaudeCodeStatuslineValueSchema.safeParse({
        command: 'my-cmd',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeHookDefinitionSchema
// ---------------------------------------------------------------------------

describe('ClaudeCodeHookDefinitionSchema', () => {
  it('accepts a minimal valid hook definition', () => {
    const result = ClaudeCodeHookDefinitionSchema.parse({
      type: 'command',
      command: 'my-hook-cmd',
    });
    expect(result.type).toBe('command');
    expect(result.command).toBe('my-hook-cmd');
    expect(result.timeout).toBeUndefined();
  });

  it('accepts a hook definition with optional timeout', () => {
    const result = ClaudeCodeHookDefinitionSchema.parse({
      type: 'command',
      command: 'my-hook-cmd',
      timeout: 5000,
    });
    expect(result.timeout).toBe(5000);
  });

  it('requires the type literal to be exactly "command"', () => {
    expect(
      ClaudeCodeHookDefinitionSchema.safeParse({
        type: 'function',
        command: 'my-cmd',
      }).success,
    ).toBe(false);
  });

  it('rejects a hook definition missing the type field', () => {
    expect(
      ClaudeCodeHookDefinitionSchema.safeParse({
        command: 'my-cmd',
      }).success,
    ).toBe(false);
  });

  it('rejects a hook definition missing the command field', () => {
    expect(
      ClaudeCodeHookDefinitionSchema.safeParse({
        type: 'command',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeHookMatcherGroupSchema
// ---------------------------------------------------------------------------

describe('ClaudeCodeHookMatcherGroupSchema', () => {
  it('accepts a matcher group with hooks and an optional matcher', () => {
    const result = ClaudeCodeHookMatcherGroupSchema.parse({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'check.sh' }],
    });
    expect(result.matcher).toBe('Bash');
    expect(result.hooks).toHaveLength(1);
  });

  it('accepts a matcher group without a matcher (catch-all)', () => {
    const result = ClaudeCodeHookMatcherGroupSchema.parse({
      hooks: [{ type: 'command', command: 'audit.sh' }],
    });
    expect(result.matcher).toBeUndefined();
    expect(result.hooks).toHaveLength(1);
  });

  it('accepts a matcher group with multiple hooks', () => {
    const result = ClaudeCodeHookMatcherGroupSchema.parse({
      hooks: [
        { type: 'command', command: 'first.sh' },
        { type: 'command', command: 'second.sh', timeout: 3000 },
      ],
    });
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[1]?.timeout).toBe(3000);
  });

  it('rejects a matcher group with an invalid hook definition', () => {
    expect(
      ClaudeCodeHookMatcherGroupSchema.safeParse({
        hooks: [{ type: 'invalid', command: 'cmd' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a matcher group missing the hooks array', () => {
    expect(ClaudeCodeHookMatcherGroupSchema.safeParse({ matcher: 'Bash' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeConfigSchemas — request/response pairs
// ---------------------------------------------------------------------------

describe('ClaudeCodeConfigSchemas', () => {
  describe('config.statusline.list', () => {
    const schema = ClaudeCodeConfigSchemas['config.statusline.list'];

    it('accepts a valid request with optional projectDir', () => {
      expect(schema.request.parse({ projectDir: '/my/project' })).toEqual({
        projectDir: '/my/project',
      });
    });

    it('accepts an empty request (projectDir optional)', () => {
      expect(schema.request.parse({})).toEqual({});
    });

    it('rejects a relative projectDir', () => {
      expect(schema.request.safeParse({ projectDir: './my-project' }).success).toBe(false);
    });

    it('accepts a valid response with effective value and perScope entries', () => {
      const result = schema.response.parse({
        effective: { type: 'command', command: 'status.sh' },
        perScope: [
          {
            scope: 'user',
            path: '/home/user/.claude/settings.json',
            value: { type: 'command', command: 'status.sh' },
          },
          { scope: 'project', path: '/project/.claude/settings.json', value: null },
          { scope: 'local', path: '/project/.claude/settings.local.json', value: null },
        ],
      });
      expect(result.effective?.command).toBe('status.sh');
      expect(result.perScope).toHaveLength(3);
    });

    it('accepts a response with null effective value', () => {
      const result = schema.response.parse({ effective: null, perScope: [] });
      expect(result.effective).toBeNull();
    });

    it('rejects a response missing the perScope field', () => {
      expect(schema.response.safeParse({ effective: null }).success).toBe(false);
    });
  });

  describe('config.statusline.set', () => {
    const schema = ClaudeCodeConfigSchemas['config.statusline.set'];

    it('accepts a valid set request', () => {
      const result = schema.request.parse({
        scope: 'user',
        value: { type: 'command', command: 'my-status.sh' },
      });
      expect(result.scope).toBe('user');
      expect(result.value.command).toBe('my-status.sh');
    });

    it('accepts a set request with optional projectDir', () => {
      const result = schema.request.parse({
        scope: 'project',
        projectDir: '/my/project',
        value: { type: 'command', command: 'status.sh', padding: 1 },
      });
      expect(result.projectDir).toBe('/my/project');
    });

    it('rejects a set request with an invalid scope', () => {
      expect(
        schema.request.safeParse({
          scope: 'managed',
          value: { type: 'command', command: 'status.sh' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope project without projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          value: { type: 'command', command: 'status.sh' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope local without projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'local',
          value: { type: 'command', command: 'status.sh' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope project with empty projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          projectDir: '',
          value: { type: 'command', command: 'status.sh' },
        }).success,
      ).toBe(false);
    });

    it('accepts scope user without projectDir', () => {
      const result = schema.request.parse({
        scope: 'user',
        value: { type: 'command', command: 'status.sh' },
      });
      expect(result.scope).toBe('user');
      expect(result.projectDir).toBeUndefined();
    });

    it('accepts a valid set response', () => {
      const result = schema.response.parse({
        previous: null,
        applied: { type: 'command', command: 'new-status.sh' },
      });
      expect(result.previous).toBeNull();
      expect(result.applied.command).toBe('new-status.sh');
    });
  });

  describe('config.hooks.list', () => {
    const schema = ClaudeCodeConfigSchemas['config.hooks.list'];

    it('accepts an empty hooks.list request', () => {
      expect(schema.request.parse({})).toEqual({});
    });

    it('accepts a hooks.list request filtering by eventName', () => {
      const result = schema.request.parse({ eventName: 'PreToolUse', projectDir: '/repo' });
      expect(result.eventName).toBe('PreToolUse');
    });

    it('accepts a valid hooks.list response', () => {
      const result = schema.response.parse({
        effective: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }],
        },
        perScope: [
          {
            scope: 'user',
            path: '/home/.claude/settings.json',
            events: {
              PreToolUse: [{ hooks: [{ type: 'command', command: 'check.sh' }] }],
            },
          },
        ],
      });
      expect(result.effective['PreToolUse']).toHaveLength(1);
      expect(result.perScope[0]?.scope).toBe('user');
    });

    it('accepts an empty effective hooks map', () => {
      const result = schema.response.parse({ effective: {}, perScope: [] });
      expect(result.effective).toEqual({});
    });
  });

  describe('config.hooks.add', () => {
    const schema = ClaudeCodeConfigSchemas['config.hooks.add'];

    it('accepts a valid hooks.add request', () => {
      const result = schema.request.parse({
        scope: 'project',
        projectDir: '/repo',
        eventName: 'PostToolUse',
        matcher: 'Write',
        hook: { type: 'command', command: 'lint.sh', timeout: 10000 },
      });
      expect(result.hook.command).toBe('lint.sh');
      expect(result.hook.timeout).toBe(10000);
    });

    it('accepts a hooks.add request without optional matcher', () => {
      const result = schema.request.parse({
        scope: 'local',
        projectDir: '/repo',
        eventName: 'PreToolUse',
        hook: { type: 'command', command: 'guard.sh' },
      });
      expect(result.matcher).toBeUndefined();
    });

    it('rejects a hooks.add request with a hook missing the type field', () => {
      expect(
        schema.request.safeParse({
          scope: 'user',
          eventName: 'PreToolUse',
          hook: { command: 'guard.sh' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope project without projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          eventName: 'PreToolUse',
          hook: { type: 'command', command: 'guard.sh' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope local without projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'local',
          eventName: 'PreToolUse',
          hook: { type: 'command', command: 'guard.sh' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope project with empty projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          projectDir: '',
          eventName: 'PreToolUse',
          hook: { type: 'command', command: 'guard.sh' },
        }).success,
      ).toBe(false);
    });

    it('accepts scope user without projectDir', () => {
      const result = schema.request.parse({
        scope: 'user',
        eventName: 'PreToolUse',
        hook: { type: 'command', command: 'guard.sh' },
      });
      expect(result.scope).toBe('user');
      expect(result.projectDir).toBeUndefined();
    });

    it('accepts a valid hooks.add response indicating success', () => {
      expect(schema.response.parse({ added: true })).toEqual({ added: true });
    });

    it('accepts a hooks.add response indicating no-op (already existed)', () => {
      expect(schema.response.parse({ added: false })).toEqual({ added: false });
    });
  });

  describe('config.hooks.remove', () => {
    const schema = ClaudeCodeConfigSchemas['config.hooks.remove'];

    it('accepts a valid hooks.remove request', () => {
      const result = schema.request.parse({
        scope: 'project',
        projectDir: '/repo',
        eventName: 'PostToolUse',
        match: { commandContains: 'lint' },
      });
      expect(result.match.commandContains).toBe('lint');
    });

    it('rejects a hooks.remove request missing the match field', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          eventName: 'PostToolUse',
        }).success,
      ).toBe(false);
    });

    it('rejects a hooks.remove request with match missing commandContains', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          eventName: 'PostToolUse',
          match: {},
        }).success,
      ).toBe(false);
    });

    it('rejects scope project without projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          eventName: 'PostToolUse',
          match: { commandContains: 'lint' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope local without projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'local',
          eventName: 'PostToolUse',
          match: { commandContains: 'lint' },
        }).success,
      ).toBe(false);
    });

    it('rejects scope project with empty projectDir', () => {
      expect(
        schema.request.safeParse({
          scope: 'project',
          projectDir: '',
          eventName: 'PostToolUse',
          match: { commandContains: 'lint' },
        }).success,
      ).toBe(false);
    });

    it('accepts scope user without projectDir', () => {
      const result = schema.request.parse({
        scope: 'user',
        eventName: 'PostToolUse',
        match: { commandContains: 'lint' },
      });
      expect(result.scope).toBe('user');
      expect(result.projectDir).toBeUndefined();
    });

    it('accepts a valid hooks.remove response', () => {
      expect(schema.response.parse({ removed: 3 })).toEqual({ removed: 3 });
    });

    it('accepts a hooks.remove response of zero (nothing matched)', () => {
      expect(schema.response.parse({ removed: 0 })).toEqual({ removed: 0 });
    });
  });

  describe('config.plugins.list', () => {
    const schema = ClaudeCodeConfigSchemas['config.plugins.list'];

    it('accepts an empty extensions.list request', () => {
      expect(schema.request.parse({})).toEqual({});
    });

    it('accepts a valid extensions.list response', () => {
      const result = schema.response.parse({
        plugins: [
          { name: '@company/my-plugin', enabled: true, scope: 'project' },
          { name: '@company/other-plugin', enabled: false, scope: 'user' },
        ],
      });
      expect(result.plugins).toHaveLength(2);
      expect(result.plugins[0]?.name).toBe('@company/my-plugin');
      expect(result.plugins[1]?.enabled).toBe(false);
    });

    it('accepts an empty extensions list', () => {
      expect(schema.response.parse({ plugins: [] })).toEqual({ plugins: [] });
    });

    it('rejects a plugin entry with an invalid scope', () => {
      expect(
        schema.response.safeParse({
          plugins: [{ name: 'my-plugin', enabled: true, scope: 'managed' }],
        }).success,
      ).toBe(false);
    });

    it('rejects a plugin entry missing the name field', () => {
      expect(
        schema.response.safeParse({
          plugins: [{ enabled: true, scope: 'user' }],
        }).success,
      ).toBe(false);
    });
  });
});
