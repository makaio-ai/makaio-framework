/**
 * Sync invariant test: ensures `hookEvents` in the Claude Code client
 * definition stays in sync with the canonical hook name constants in
 * `runtime/schemas.ts`.
 *
 * If a constant is added to `schemas.ts` without updating `definition.ts`,
 * or vice-versa, one of these tests will fail.
 */
import { describe, it, expect } from 'vitest';
import { clientDefinition } from '../../definition.js';
import {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
  CLAUDE_CODE_HOOK_NOTIFICATION,
  CLAUDE_CODE_HOOK_MCP_SERVER_START,
  CLAUDE_CODE_HOOK_MCP_SERVER_STOP,
} from '../schemas.js';

const ALL_CLAUDE_CODE_HOOK_NAMES = [
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
  CLAUDE_CODE_HOOK_NOTIFICATION,
  CLAUDE_CODE_HOOK_MCP_SERVER_START,
  CLAUDE_CODE_HOOK_MCP_SERVER_STOP,
];

describe('Claude Code hookEvents sync', () => {
  it('declares hookEvents for every known hook constant', () => {
    const declaredNames = clientDefinition.runtimeCapabilities.hookEvents.map((e) => e.name);
    for (const hookName of ALL_CLAUDE_CODE_HOOK_NAMES) {
      expect(declaredNames, `missing hookEvent for ${hookName}`).toContain(hookName);
    }
  });

  it('does not declare hookEvents beyond known constants', () => {
    const declaredNames = clientDefinition.runtimeCapabilities.hookEvents.map((e) => e.name);
    for (const name of declaredNames) {
      expect(ALL_CLAUDE_CODE_HOOK_NAMES, `unexpected hookEvent ${name}`).toContain(name);
    }
  });

  it('sets supportsHooks to true', () => {
    expect(clientDefinition.runtimeCapabilities.supportsHooks).toBe(true);
  });

  it('sets supportsStatusline to true', () => {
    expect(clientDefinition.runtimeCapabilities.supportsStatusline).toBe(true);
  });
});
