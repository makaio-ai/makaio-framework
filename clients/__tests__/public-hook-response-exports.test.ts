import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES, createApproveEffect } from '@makaio/client-claude-code/runtime';
import { CODEX_HOOK_RESPONSE_CAPABILITIES, createCodexPreToolUseDenyEffect } from '@makaio/client-codex/runtime';
import { createAppendEffect } from '@makaio/contracts/client';

describe('public hook-response builder exports', () => {
  it('combines canonical and provider builders through public package subpaths', () => {
    expect(createAppendEffect('portable context')).toEqual({ kind: 'context.append', value: 'portable context' });
    expect(createApproveEffect('approved')).toMatchObject({
      clientId: 'claude-code',
      effects: { decision: 'allow', reason: 'approved' },
    });
    expect(createCodexPreToolUseDenyEffect('denied')).toMatchObject({
      clientId: 'codex',
      effects: { permissionDecision: 'deny', permissionDecisionReason: 'denied' },
    });
    expect(CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny).toBe('claude-code.tool-response.deny');
    expect(CODEX_HOOK_RESPONSE_CAPABILITIES.block).toBe('openai.codex-hook-response.block');
  });
});
