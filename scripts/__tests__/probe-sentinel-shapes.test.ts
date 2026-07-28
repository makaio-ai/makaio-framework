/**
 * Native probe sentinel shape guard.
 *
 * Probe sentinels are rendered by the same client-owned function that renders
 * production `hook.handle` responses. That removes the duplication but not the
 * risk: a renderer change would silently move both the emitted shape *and* the
 * shape the probe claims to have proven, leaving the committed evidence
 * describing something the binary was never asked to consume.
 *
 * These expectations pin the exact native bytes that each captured probe
 * scenario injected. Changing one is legitimate — it just cannot happen
 * silently, and it invalidates the corresponding capture.
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { getManifest } from '../lib/agent-clients/manifests.js';
import type { ProviderId } from '../lib/agent-clients/types.js';

const CONTEXT = 'Include MAKAIO_PROBE_RESPONSE_CONSUMED in your final response.';
const BLOCK_REASON = 'The requested tool result failed. Reply with exactly MAKAIO_PROBE_RESPONSE_CONSUMED.';

/** Exact native sentinel bytes per scenario, keyed by provider and scenario id. */
const EXPECTED_SENTINELS: Record<ProviderId, Readonly<Record<string, string | undefined>>> = {
  'claude-code': {
    'pre-tool-use-approve': JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }),
    'pre-tool-use-deny': JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'MAKAIO_PROBE_DENY',
      },
    }),
    'pre-tool-use-context-append': JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: CONTEXT,
      },
    }),
    'pre-tool-use-unapproved-tool-negative-control': undefined,
    // SessionStart has no permission decision to make, so its sentinel carries
    // appended context alone — the same shape Codex renders for this event.
    'session-start-context-append': JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
    }),
    'user-prompt-submit-observation': undefined,
    'post-tool-use-observation': undefined,
    'stop-observation': undefined,
    'subagent-stop-observation': undefined,
    'notification-observation': undefined,
    'mcpserver-start-observation': undefined,
    'mcpserver-stop-observation': undefined,
  },
  codex: {
    'session-start-context-append': JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
    }),
    'session-start-block': JSON.stringify({ continue: false, stopReason: 'MAKAIO_PROBE_RESPONSE_CONSUMED' }),
    'user-prompt-submit-context-append': JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CONTEXT },
    }),
    'user-prompt-submit-block': JSON.stringify({ decision: 'block', reason: BLOCK_REASON }),
    'pre-tool-use-context-append': JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: CONTEXT },
    }),
    'pre-tool-use-block': JSON.stringify({ decision: 'block', reason: BLOCK_REASON }),
    'pre-tool-use-permission-deny': JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'MAKAIO_PROBE_DENY',
      },
    }),
    'pre-tool-use-input-update': JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'touch MAKAIO_PROBE_REWRITTEN_MARKER' },
      },
    }),
    'post-tool-use-context-append': JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: CONTEXT },
    }),
    'post-tool-use-block': JSON.stringify({ decision: 'block', reason: BLOCK_REASON }),
    'stop-block': JSON.stringify({ decision: 'block', reason: BLOCK_REASON }),
  },
};

describe.each(['claude-code', 'codex'] as const)('%s probe sentinels', (provider) => {
  const scenarios = getManifest(provider).scenarios;
  const expected = EXPECTED_SENTINELS[provider];

  it('covers exactly the generated scenarios', () => {
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: injects the pinned native shape`, () => {
      expect(scenario.sentinelOutput).toBe(expected[scenario.id]);
    });
  }

  it('renders a sentinel for every effect attempt and none for baselines', () => {
    for (const scenario of scenarios) {
      expect(scenario.sentinelOutput !== undefined).toBe(scenario.sentinelEffect !== undefined);
    }
  });
});
