import { describe, expect, it } from 'bun:test';
import {
  CodexScopeSchema,
  CodexHookEntrySchema,
  CodexNativeCommandHookSchema,
  CodexNativeHooksFileSchema,
  CodexScopeHookRecordSchema,
  CodexConfigHooksListRequestSchema,
  CodexConfigHooksListResponseSchema,
  CodexConfigHooksAddRequestSchema,
  CodexConfigHooksAddResponseSchema,
  CodexConfigHooksRemoveRequestSchema,
  CodexConfigHooksRemoveResponseSchema,
  CodexConfigSchemas,
} from '../config.js';

// ---------------------------------------------------------------------------
// CodexScopeSchema
// ---------------------------------------------------------------------------

describe('CodexScopeSchema', () => {
  it('accepts valid scope values', () => {
    expect(CodexScopeSchema.parse('global')).toBe('global');
    expect(CodexScopeSchema.parse('project')).toBe('project');
  });

  it('rejects unknown scope strings', () => {
    expect(CodexScopeSchema.safeParse('user').success).toBe(false);
    expect(CodexScopeSchema.safeParse('').success).toBe(false);
    expect(CodexScopeSchema.safeParse(42).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Native Codex hooks.json schemas
// ---------------------------------------------------------------------------

describe('CodexNativeHooksFileSchema', () => {
  it('accepts Codex native event, matcher-group, and command-handler structure', () => {
    const file = CodexNativeHooksFileSchema.parse({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [
              {
                type: 'command',
                command: 'python3 ~/.codex/hooks/session_start.py',
                statusMessage: 'Loading session notes',
                timeout: 30,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/bin/python3 .codex/hooks/pre_tool_use.py' }],
          },
        ],
      },
    });

    expect(file.hooks?.['SessionStart']?.[0]?.matcher).toBe('startup|resume');
    expect(file.hooks?.['PreToolUse']?.[0]?.hooks).toHaveLength(1);
  });

  it('preserves unknown native fields for lossless writes', () => {
    const file = CodexNativeHooksFileSchema.parse({
      version: 1,
      hooks: {
        Stop: [
          {
            customGroupField: 'group',
            hooks: [
              {
                type: 'command',
                command: 'echo stop',
                customHandlerField: 'handler',
              },
            ],
          },
        ],
      },
      customTopLevelField: 'top',
    });

    expect(file).toMatchObject({
      version: 1,
      customTopLevelField: 'top',
      hooks: {
        Stop: [
          {
            customGroupField: 'group',
            hooks: [{ customHandlerField: 'handler' }],
          },
        ],
      },
    });
  });

  it('rejects the obsolete flat hooks array shape', () => {
    expect(
      CodexNativeHooksFileSchema.safeParse({
        hooks: [{ event: 'PreToolUse', command: 'echo obsolete' }],
      }).success,
    ).toBe(false);
  });
});

describe('CodexNativeCommandHookSchema', () => {
  it('accepts timeoutSec as Codex native timeout alias', () => {
    const hook = CodexNativeCommandHookSchema.parse({
      type: 'command',
      command: 'echo alias',
      timeoutSec: 10,
    });

    expect(hook.timeoutSec).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// CodexHookEntrySchema
// ---------------------------------------------------------------------------

describe('CodexHookEntrySchema', () => {
  it('accepts a minimal hook entry with only required fields', () => {
    const entry = CodexHookEntrySchema.parse({
      event: 'PreToolUse',
      command: 'echo hello',
    });

    expect(entry.event).toBe('PreToolUse');
    expect(entry.command).toBe('echo hello');
    expect(entry.matcher).toBeUndefined();
    expect(entry.timeout).toBeUndefined();
  });

  it('accepts a full hook entry with all optional fields', () => {
    const entry = CodexHookEntrySchema.parse({
      event: 'PostToolUse',
      matcher: 'bash',
      command: '/usr/local/bin/my-hook.sh',
      timeout: 5000,
    });

    expect(entry.event).toBe('PostToolUse');
    expect(entry.matcher).toBe('bash');
    expect(entry.command).toBe('/usr/local/bin/my-hook.sh');
    expect(entry.timeout).toBe(5000);
  });

  it('handles optional matcher field independently of optional timeout field', () => {
    const withMatcherOnly = CodexHookEntrySchema.parse({
      event: 'PreToolUse',
      matcher: 'patch',
      command: 'echo patching',
    });
    expect(withMatcherOnly.matcher).toBe('patch');
    expect(withMatcherOnly.timeout).toBeUndefined();

    const withTimeoutOnly = CodexHookEntrySchema.parse({
      event: 'PreToolUse',
      command: 'echo patching',
      timeout: 3000,
    });
    expect(withTimeoutOnly.matcher).toBeUndefined();
    expect(withTimeoutOnly.timeout).toBe(3000);
  });

  it('rejects a hook entry missing the required event field', () => {
    expect(
      CodexHookEntrySchema.safeParse({
        command: 'echo missing event',
      }).success,
    ).toBe(false);
  });

  it('rejects a hook entry missing the required command field', () => {
    expect(
      CodexHookEntrySchema.safeParse({
        event: 'PreToolUse',
      }).success,
    ).toBe(false);
  });

  it('rejects a hook entry with non-string event', () => {
    expect(
      CodexHookEntrySchema.safeParse({
        event: 42,
        command: 'echo hello',
      }).success,
    ).toBe(false);
  });

  it('rejects a hook entry with non-numeric timeout', () => {
    expect(
      CodexHookEntrySchema.safeParse({
        event: 'PreToolUse',
        command: 'echo hello',
        timeout: '5000',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CodexScopeHookRecordSchema
// ---------------------------------------------------------------------------

describe('CodexScopeHookRecordSchema', () => {
  it('accepts a valid scope hook record', () => {
    const record = CodexScopeHookRecordSchema.parse({
      scope: 'project',
      path: '/home/user/project/.codex/hooks.json',
      writable: true,
      hooks: [
        { event: 'PreToolUse', command: 'echo pre' },
        { event: 'PostToolUse', matcher: 'bash', command: 'echo post', timeout: 2000 },
      ],
    });

    expect(record.scope).toBe('project');
    expect(record.writable).toBe(true);
    expect(record.hooks).toHaveLength(2);
    expect(record.hooks[0]?.event).toBe('PreToolUse');
    expect(record.hooks[1]?.matcher).toBe('bash');
  });

  it('accepts a scope hook record with an empty hooks array', () => {
    const record = CodexScopeHookRecordSchema.parse({
      scope: 'global',
      path: '/home/user/.codex/hooks.json',
      writable: false,
      hooks: [],
    });

    expect(record.scope).toBe('global');
    expect(record.hooks).toHaveLength(0);
  });

  it('rejects a scope hook record with an invalid scope value', () => {
    expect(
      CodexScopeHookRecordSchema.safeParse({
        scope: 'workspace',
        path: '/some/path',
        writable: true,
        hooks: [],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config.hooks.list request/response
// ---------------------------------------------------------------------------

describe('CodexConfigHooksListRequestSchema', () => {
  it('accepts an empty request (all fields optional)', () => {
    const req = CodexConfigHooksListRequestSchema.parse({});
    expect(req.projectDir).toBeUndefined();
    expect(req.eventName).toBeUndefined();
  });

  it('accepts a request with only projectDir', () => {
    const req = CodexConfigHooksListRequestSchema.parse({
      projectDir: '/home/user/project',
    });
    expect(req.projectDir).toBe('/home/user/project');
    expect(req.eventName).toBeUndefined();
  });

  it('accepts a request with both optional fields', () => {
    const req = CodexConfigHooksListRequestSchema.parse({
      projectDir: '/home/user/project',
      eventName: 'PreToolUse',
    });
    expect(req.projectDir).toBe('/home/user/project');
    expect(req.eventName).toBe('PreToolUse');
  });

  it('rejects a relative projectDir', () => {
    expect(
      CodexConfigHooksListRequestSchema.safeParse({
        projectDir: 'relative/project',
      }).success,
    ).toBe(false);
  });
});

describe('CodexConfigHooksListResponseSchema', () => {
  it('accepts a valid list response with effective hooks and per-scope breakdown', () => {
    const resp = CodexConfigHooksListResponseSchema.parse({
      effective: [
        { event: 'PreToolUse', command: 'echo global-hook' },
        { event: 'PostToolUse', matcher: 'bash', command: 'echo project-hook', timeout: 1000 },
      ],
      perScope: [
        {
          scope: 'global',
          path: '/home/user/.codex/hooks.json',
          writable: true,
          hooks: [{ event: 'PreToolUse', command: 'echo global-hook' }],
        },
        {
          scope: 'project',
          path: '/home/user/project/.codex/hooks.json',
          writable: true,
          hooks: [
            {
              event: 'PostToolUse',
              matcher: 'bash',
              command: 'echo project-hook',
              timeout: 1000,
            },
          ],
        },
      ],
    });

    expect(resp.effective).toHaveLength(2);
    expect(resp.perScope).toHaveLength(2);
    expect(resp.perScope[0]?.scope).toBe('global');
    expect(resp.perScope[1]?.scope).toBe('project');
  });

  it('accepts a response with empty effective and perScope arrays', () => {
    const resp = CodexConfigHooksListResponseSchema.parse({
      effective: [],
      perScope: [],
    });

    expect(resp.effective).toHaveLength(0);
    expect(resp.perScope).toHaveLength(0);
  });

  it('rejects a response missing the effective field', () => {
    expect(
      CodexConfigHooksListResponseSchema.safeParse({
        perScope: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a response missing the perScope field', () => {
    expect(
      CodexConfigHooksListResponseSchema.safeParse({
        effective: [],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config.hooks.add request/response
// ---------------------------------------------------------------------------

describe('CodexConfigHooksAddRequestSchema', () => {
  it('accepts a minimal add request (required fields only)', () => {
    const req = CodexConfigHooksAddRequestSchema.parse({
      scope: 'global',
      event: 'PreToolUse',
      command: 'echo pre',
    });

    expect(req.scope).toBe('global');
    expect(req.event).toBe('PreToolUse');
    expect(req.command).toBe('echo pre');
    expect(req.projectDir).toBeUndefined();
    expect(req.matcher).toBeUndefined();
    expect(req.timeout).toBeUndefined();
  });

  it('accepts a full add request with all optional fields', () => {
    const req = CodexConfigHooksAddRequestSchema.parse({
      projectDir: '/home/user/project',
      scope: 'project',
      event: 'PostToolUse',
      matcher: 'bash',
      command: '/usr/local/bin/audit.sh',
      timeout: 10000,
    });

    expect(req.projectDir).toBe('/home/user/project');
    expect(req.matcher).toBe('bash');
    expect(req.timeout).toBe(10000);
  });

  it('rejects a project-scope add request without projectDir', () => {
    expect(
      CodexConfigHooksAddRequestSchema.safeParse({
        scope: 'project',
        event: 'PreToolUse',
        command: 'echo pre',
      }).success,
    ).toBe(false);
  });

  it('rejects an add request with a relative projectDir', () => {
    expect(
      CodexConfigHooksAddRequestSchema.safeParse({
        projectDir: 'relative/project',
        scope: 'project',
        event: 'PreToolUse',
        command: 'echo pre',
      }).success,
    ).toBe(false);
  });

  it('rejects an add request missing the required scope field', () => {
    expect(
      CodexConfigHooksAddRequestSchema.safeParse({
        event: 'PreToolUse',
        command: 'echo pre',
      }).success,
    ).toBe(false);
  });

  it('rejects an add request with an invalid scope value', () => {
    expect(
      CodexConfigHooksAddRequestSchema.safeParse({
        scope: 'workspace',
        event: 'PreToolUse',
        command: 'echo pre',
      }).success,
    ).toBe(false);
  });

  it('rejects an add request missing the required event field', () => {
    expect(
      CodexConfigHooksAddRequestSchema.safeParse({
        scope: 'global',
        command: 'echo pre',
      }).success,
    ).toBe(false);
  });

  it('rejects an add request missing the required command field', () => {
    expect(
      CodexConfigHooksAddRequestSchema.safeParse({
        scope: 'global',
        event: 'PreToolUse',
      }).success,
    ).toBe(false);
  });
});

describe('CodexConfigHooksAddResponseSchema', () => {
  it('accepts a successful add response', () => {
    const resp = CodexConfigHooksAddResponseSchema.parse({ added: true });
    expect(resp.added).toBe(true);
  });

  it('accepts a failed add response', () => {
    const resp = CodexConfigHooksAddResponseSchema.parse({ added: false });
    expect(resp.added).toBe(false);
  });

  it('rejects a response missing the added field', () => {
    expect(CodexConfigHooksAddResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a response with non-boolean added field', () => {
    expect(CodexConfigHooksAddResponseSchema.safeParse({ added: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config.hooks.remove request/response
// ---------------------------------------------------------------------------

describe('CodexConfigHooksRemoveRequestSchema', () => {
  it('accepts a valid remove request', () => {
    const req = CodexConfigHooksRemoveRequestSchema.parse({
      scope: 'global',
      event: 'PreToolUse',
      match: { commandContains: 'audit.sh' },
    });

    expect(req.scope).toBe('global');
    expect(req.event).toBe('PreToolUse');
    expect(req.match.commandContains).toBe('audit.sh');
    expect(req.projectDir).toBeUndefined();
  });

  it('accepts a remove request with an optional projectDir', () => {
    const req = CodexConfigHooksRemoveRequestSchema.parse({
      projectDir: '/home/user/project',
      scope: 'project',
      event: 'PostToolUse',
      match: { commandContains: 'echo' },
    });

    expect(req.projectDir).toBe('/home/user/project');
  });

  it('rejects a project-scope remove request without projectDir', () => {
    expect(
      CodexConfigHooksRemoveRequestSchema.safeParse({
        scope: 'project',
        event: 'PreToolUse',
        match: { commandContains: 'audit.sh' },
      }).success,
    ).toBe(false);
  });

  it('rejects a remove request with a relative projectDir', () => {
    expect(
      CodexConfigHooksRemoveRequestSchema.safeParse({
        projectDir: 'relative/project',
        scope: 'project',
        event: 'PostToolUse',
        match: { commandContains: 'echo' },
      }).success,
    ).toBe(false);
  });

  it('rejects a remove request missing the match field', () => {
    expect(
      CodexConfigHooksRemoveRequestSchema.safeParse({
        scope: 'global',
        event: 'PreToolUse',
      }).success,
    ).toBe(false);
  });

  it('rejects a remove request with a match object missing commandContains', () => {
    expect(
      CodexConfigHooksRemoveRequestSchema.safeParse({
        scope: 'global',
        event: 'PreToolUse',
        match: {},
      }).success,
    ).toBe(false);
  });

  it('rejects a remove request missing the required event field', () => {
    expect(
      CodexConfigHooksRemoveRequestSchema.safeParse({
        scope: 'global',
        match: { commandContains: 'echo' },
      }).success,
    ).toBe(false);
  });
});

describe('CodexConfigHooksRemoveResponseSchema', () => {
  it('accepts a response indicating hooks were removed', () => {
    const resp = CodexConfigHooksRemoveResponseSchema.parse({ removed: 2 });
    expect(resp.removed).toBe(2);
  });

  it('accepts a response indicating no hooks were removed', () => {
    const resp = CodexConfigHooksRemoveResponseSchema.parse({ removed: 0 });
    expect(resp.removed).toBe(0);
  });

  it('rejects a response with a non-numeric removed field', () => {
    expect(CodexConfigHooksRemoveResponseSchema.safeParse({ removed: '2' }).success).toBe(false);
  });

  it('rejects a response missing the removed field', () => {
    expect(CodexConfigHooksRemoveResponseSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CodexConfigSchemas record shape
// ---------------------------------------------------------------------------

describe('CodexConfigSchemas', () => {
  it('contains all three config.hooks subject keys', () => {
    expect(Object.keys(CodexConfigSchemas)).toEqual(
      expect.arrayContaining(['config.hooks.list', 'config.hooks.add', 'config.hooks.remove']),
    );
  });

  it('each entry is a request/response pair with Zod schemas', () => {
    for (const key of ['config.hooks.list', 'config.hooks.add', 'config.hooks.remove'] as const) {
      const entry = CodexConfigSchemas[key];
      expect(entry).toHaveProperty('request');
      expect(entry).toHaveProperty('response');
      // Verify they are Zod schemas by calling safeParse
      expect(typeof entry.request.safeParse).toBe('function');
      expect(typeof entry.response.safeParse).toBe('function');
    }
  });

  it('config.hooks.list request and response schemas are consistent with their standalone counterparts', () => {
    const listEntry = CodexConfigSchemas['config.hooks.list'];
    expect(listEntry.request).toBe(CodexConfigHooksListRequestSchema);
    expect(listEntry.response).toBe(CodexConfigHooksListResponseSchema);
  });

  it('config.hooks.add request and response schemas are consistent with their standalone counterparts', () => {
    const addEntry = CodexConfigSchemas['config.hooks.add'];
    expect(addEntry.request).toBe(CodexConfigHooksAddRequestSchema);
    expect(addEntry.response).toBe(CodexConfigHooksAddResponseSchema);
  });

  it('config.hooks.remove request and response schemas are consistent with their standalone counterparts', () => {
    const removeEntry = CodexConfigSchemas['config.hooks.remove'];
    expect(removeEntry.request).toBe(CodexConfigHooksRemoveRequestSchema);
    expect(removeEntry.response).toBe(CodexConfigHooksRemoveResponseSchema);
  });
});
