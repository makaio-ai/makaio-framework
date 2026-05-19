/**
 * Sync invariant test: ensures `hookEvents` in the Codex client definition
 * stays in sync with the canonical hook name constants in
 * `runtime/schemas.ts`.
 *
 * If a constant is added to `schemas.ts` without updating `definition.ts`,
 * or vice-versa, one of these tests will fail.
 */
import { describe, it, expect } from 'bun:test';
import { clientDefinition } from '../../definition.js';
import {
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_POST_TOOL_USE,
  CODEX_HOOK_STOP,
} from '../schemas.js';

const CODEX_HOOK_NAMES = [
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_POST_TOOL_USE,
  CODEX_HOOK_STOP,
];

describe('Codex hookEvents sync', () => {
  it('declares hookEvents for every known hook name', () => {
    const declaredNames = clientDefinition.runtimeCapabilities.hookEvents.map((e) => e.name);
    for (const hookName of CODEX_HOOK_NAMES) {
      expect(declaredNames, `missing hookEvent for ${hookName}`).toContain(hookName);
    }
  });

  it('does not declare hookEvents beyond known names', () => {
    const declaredNames = clientDefinition.runtimeCapabilities.hookEvents.map((e) => e.name);
    for (const name of declaredNames) {
      expect(CODEX_HOOK_NAMES, `unexpected hookEvent ${name}`).toContain(name);
    }
  });

  it('sets supportsHooks to true', () => {
    expect(clientDefinition.runtimeCapabilities.supportsHooks).toBe(true);
  });

  it('sets supportsStatusline to false', () => {
    expect(clientDefinition.runtimeCapabilities.supportsStatusline).toBe(false);
  });
});
