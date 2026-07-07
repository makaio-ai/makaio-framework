import { describe, expect, it } from 'vitest';
import { buildQueryOptions } from '../src/utils/buildQueryOptions.js';
import type { ClaudeSessionConfig } from '../src/types/index.js';
import { SessionLifecycle } from '@makaio/ai-adapters-core';

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
