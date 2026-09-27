import { describe, expect, it } from 'vitest';
import { buildQueryOptions } from '../src/utils/buildQueryOptions.js';
import type { ClaudeSessionConfig } from '../src/types/index.js';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import { ToolNameError } from '@makaio/contracts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * Minimal `ClaudeSessionConfig` fixture for `buildQueryOptions` unit tests.
 * Only populates fields required to produce a well-formed `Options` object.
 * @param overrides - Partial config fields to override defaults.
 */
function makeMinimalConfig(overrides: Partial<ClaudeSessionConfig> = {}): ClaudeSessionConfig {
  return {
    bus: {} as ClaudeSessionConfig['bus'],
    adapterId: 'adapter-test',
    adapterName: 'claude-agent-sdk',
    agentId: 'agent-test',
    cwd: '/tmp',
    model: 'claude-sonnet-4-20250514',
    env: {},
    ...overrides,
  };
}

/**
 * Minimal `SessionLifecycle` stub — only `onAbort` is exercised by `buildQueryOptions`.
 * Uses a real instance so the return type is satisfied without unsafe casts.
 */
function makeLifecycleStub(): SessionLifecycle {
  return new SessionLifecycle();
}

describe('buildQueryOptions — responseSchema behaviour', () => {
  it('passes response schema descriptor schema to SDK outputFormat', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
      responseSchema: { schema: { type: 'object' }, name: 'object_schema' },
    });

    expect(options.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('omits outputFormat when responseSchema is not provided', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options).not.toHaveProperty('outputFormat');
  });
});

describe('buildQueryOptions — resume behaviour', () => {
  it('omits sessionId when resuming an existing SDK session', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      resumeAdapterSessionId: 'provider-session-id',
      responseSchema: { schema: { type: 'object' }, name: 'object_schema' },
    });

    expect(options.resume).toBe('provider-session-id');
    expect(options).not.toHaveProperty('sessionId');
  });
});

describe('buildQueryOptions — native fork behaviour', () => {
  it('tip fork: emits resume + forkSession:true, no sessionId', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
      },
    });

    expect(options.resume).toBe('provider-source');
    expect(options.forkSession).toBe(true);
    expect(options).not.toHaveProperty('sessionId');
    expect(options).not.toHaveProperty('resumeSessionAt');
  });

  it('mid-history fork: emits resume + resumeSessionAt + forkSession:true, no sessionId', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
        forkPointMessageId: 'msg-checkpoint',
      },
    });

    expect(options.resume).toBe('provider-source');
    expect(options.resumeSessionAt).toBe('msg-checkpoint');
    expect(options.forkSession).toBe(true);
    expect(options).not.toHaveProperty('sessionId');
  });

  it('nativeFork takes precedence over resumeAdapterSessionId', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      resumeAdapterSessionId: 'ignored-resume',
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
      },
    });

    expect(options.resume).toBe('provider-source');
    expect(options.forkSession).toBe(true);
  });
});

describe('buildQueryOptions — persistSession behaviour', () => {
  it('defaults persistSession to true when not configured', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.persistSession).toBe(true);
  });

  it('disables persistSession for ephemeral agents regardless of providerConfig override', () => {
    const config = makeMinimalConfig({
      ephemeral: true,
      providerConfig: {
        queryOptions: {
          persistSession: true,
        },
      },
    });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.persistSession).toBe(false);
  });

  it('respects an explicit persistSession: false override for non-ephemeral agents', () => {
    const config = makeMinimalConfig({
      providerConfig: {
        queryOptions: {
          persistSession: false,
        },
      },
    });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.persistSession).toBe(false);
  });
});

describe('buildQueryOptions — maxThinkingTokens behaviour', () => {
  it('omits maxThinkingTokens when reasoningEffort is not configured', () => {
    const config = makeMinimalConfig(); // no reasoningEffort
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options).not.toHaveProperty('maxThinkingTokens');
  });

  it('omits maxThinkingTokens when reasoningEffort is "none"', () => {
    const config = makeMinimalConfig({ reasoningEffort: 'none' });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options).not.toHaveProperty('maxThinkingTokens');
  });

  it.each([
    ['low', 4000],
    ['medium', 8000],
    ['high', 16000],
    ['extra-high', 32000],
  ] as const)('reasoningEffort "%s" sets maxThinkingTokens to %i', (level, expectedTokens) => {
    const config = makeMinimalConfig({ reasoningEffort: level });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.maxThinkingTokens).toBe(expectedTokens);
  });
});

describe('buildQueryOptions — tool policy behaviour', () => {
  /**
   * Build SDK options for a config carrying the given tool policy.
   * @param overrides - Tool policy fields (and any other config overrides).
   * @returns SDK query options.
   */
  function buildWithToolPolicy(overrides: Partial<ClaudeSessionConfig>) {
    return buildQueryOptions({
      config: makeMinimalConfig(overrides),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });
  }

  it('leaves tools, allowedTools and disallowedTools unset when no policy is given', () => {
    const options = buildWithToolPolicy({});

    expect(options).not.toHaveProperty('tools');
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('disallowedTools');
  });

  it('keeps provider-config tool options when no policy is given', () => {
    const options = buildWithToolPolicy({
      providerConfig: { queryOptions: { tools: ['Read'], allowedTools: ['Read'] } },
    });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual(['Read']);
  });

  it('maps a Makaio allowlist entry to the native built-in tool', () => {
    const options = buildWithToolPolicy({ allowedTools: ['read_file'] });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('restricts available tools without auto-approving them when an allowlist is given', () => {
    const allowlist = ['read_file', 'edit_file', 'write_file', 'glob_files', 'grep_files'];
    const options = buildWithToolPolicy({ allowedTools: allowlist });

    expect(options.tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options).not.toHaveProperty('disallowedTools');
  });

  it('keeps MCP allowlist entries out of the built-in tool set', () => {
    const options = buildWithToolPolicy({ allowedTools: ['read_file', 'mcp__makaio__search'] });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('accepts a command-specific permission rule on shell_exec and makes its base tool available, without auto-approving it', () => {
    const options = buildWithToolPolicy({ allowedTools: ['shell_exec(git status)'] });

    expect(options.tools).toEqual(['Bash']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('rejects native Claude tool names in the allowlist', () => {
    expect(() => buildWithToolPolicy({ allowedTools: ['Read'] })).toThrow(ToolNameError);
  });

  it('rejects WebFetch in the allowlist', () => {
    expect(() => buildWithToolPolicy({ allowedTools: ['WebFetch'] })).toThrow(ToolNameError);
  });

  it('rejects command-specific permission rules on tools other than shell_exec', () => {
    expect(() => buildWithToolPolicy({ allowedTools: ['read_file(x)'] })).toThrow(ToolNameError);
  });

  it('deduplicates allowlist entries', () => {
    const options = buildWithToolPolicy({ allowedTools: ['read_file', 'edit_file', 'read_file'] });

    expect(options.tools).toEqual(['Read', 'Edit']);
  });

  it('replaces provider-config tools with the caller allowlist and drops provider auto-approvals outside it', () => {
    const options = buildWithToolPolicy({
      allowedTools: ['read_file'],
      providerConfig: { queryOptions: { tools: ['Bash', 'Read'], allowedTools: ['Bash'] } },
    });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual([]);
  });

  it('clears all provider-config auto-approvals for an explicitly empty allowlist', () => {
    const options = buildWithToolPolicy({
      allowedTools: [],
      providerConfig: { queryOptions: { allowedTools: ['Read', 'Bash(git status)'] } },
    });

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('clears provider-config auto-approvals when only a denylist is given', () => {
    const options = buildWithToolPolicy({
      disallowedTools: ['write_file'],
      providerConfig: { queryOptions: { allowedTools: ['Bash', 'Read'] } },
    });

    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('disables all built-in tools for an explicitly empty allowlist', () => {
    const options = buildWithToolPolicy({ allowedTools: [] });

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('forces permissionMode to default when the provider config sets bypassPermissions and the caller passes a list', () => {
    const options = buildWithToolPolicy({
      allowedTools: ['read_file'],
      providerConfig: { queryOptions: { permissionMode: 'bypassPermissions' } },
    });

    expect(options.permissionMode).toBe('default');
    expect(options.allowedTools).toEqual([]);
  });

  it('forces permissionMode to default when the provider config sets acceptEdits and the caller passes a denylist', () => {
    const options = buildWithToolPolicy({
      disallowedTools: ['write_file'],
      providerConfig: { queryOptions: { permissionMode: 'acceptEdits' } },
    });

    expect(options.permissionMode).toBe('default');
    expect(options.allowedTools).toEqual([]);
  });

  it('leaves provider-config permissionMode and allowedTools untouched without caller lists', () => {
    const options = buildWithToolPolicy({
      providerConfig: { queryOptions: { permissionMode: 'bypassPermissions', allowedTools: ['Read'] } },
    });

    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowedTools).toEqual(['Read']);
  });

  it('forwards disallowedTools permission rules verbatim without restricting the available tool set', () => {
    const options = buildWithToolPolicy({ disallowedTools: ['write_file', 'shell_exec(rm:*)'] });

    expect(options.disallowedTools).toEqual(['Write', 'Bash(rm:*)']);
    expect(options).not.toHaveProperty('tools');
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('translates a denylist prefix rule to a native permission rule', () => {
    const options = buildWithToolPolicy({ disallowedTools: ['shell_exec(rm -rf:*)'] });

    expect(options.disallowedTools).toEqual(['Bash(rm -rf:*)']);
  });

  it('routes allowlisted tools through the canUseTool approval handler', () => {
    const approvalHandler: NonNullable<Options['canUseTool']> = async () => ({ behavior: 'deny', message: 'no' });
    const options = buildQueryOptions({
      config: makeMinimalConfig({ allowedTools: ['read_file'] }),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => approvalHandler,
      sessionId: 'session-test',
    });

    expect(options.canUseTool).toBe(approvalHandler);
  });
});
