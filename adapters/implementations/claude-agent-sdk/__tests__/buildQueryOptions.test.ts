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
