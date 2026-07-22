/**
 * Hook contract fixture tests for Codex.
 *
 * Delegates to the shared hook-contract fixture suite with Codex's
 * definition and fixture directory. See the shared module for the full
 * assertion set.
 * @packageDocumentation
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { CODEX_HOOK_RESPONSE_CAPABILITIES, clientDefinition } from '../../definition.js';
import { runHookContractFixtureSuite } from '../../../../__tests__/hook-contract-fixture-suite.js';
import { getManifest } from '../../../../../scripts/lib/agent-clients/manifests.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Requires a parsed fixture value to be a JSON object.
 * @param value - Parsed fixture value.
 * @returns Object fixture value.
 */
function fixtureObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected hook contract fixture to be a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Validates fields whose spelling and semantics are specific to Codex 0.144.1.
 * @param eventName - Native hook event name.
 * @param input - Parsed pinned-source input fixture.
 * @param output - Parsed pinned-source output fixture.
 */
function validateCodexEventFixtures(eventName: string, input: unknown, output: unknown): void {
  const inputRecord = fixtureObject(input);
  const outputRecord = fixtureObject(output);

  expect(inputRecord).toMatchObject({
    hook_event_name: eventName,
    session_id: expect.any(String),
    cwd: expect.any(String),
    model: expect.any(String),
    permission_mode: expect.any(String),
  });
  expect(inputRecord).toHaveProperty('transcript_path');

  if (eventName === 'SessionStart') {
    expect(inputRecord.source).toBe('startup');
    expect(outputRecord).toMatchObject({ continue: false, stopReason: expect.any(String) });
    expect(fixtureObject(outputRecord.hookSpecificOutput).hookEventName).toBe('SessionStart');
    return;
  }

  expect(inputRecord.turn_id).toEqual(expect.any(String));
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    expect(inputRecord).toMatchObject({
      tool_name: expect.any(String),
      tool_use_id: expect.any(String),
      tool_input: expect.any(Object),
    });
    expect(inputRecord).not.toHaveProperty('call_id');
  }

  if (eventName === 'PreToolUse') {
    expect(fixtureObject(outputRecord.hookSpecificOutput)).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: expect.any(Object),
    });
  } else if (eventName === 'PostToolUse') {
    expect(inputRecord.tool_response).toEqual(expect.any(Object));
    expect(inputRecord).not.toHaveProperty('success');
    expect(outputRecord).toMatchObject({ decision: 'block', reason: expect.any(String) });
    expect(fixtureObject(outputRecord.hookSpecificOutput).hookEventName).toBe('PostToolUse');
  } else if (eventName === 'Stop') {
    expect(inputRecord).toHaveProperty('last_assistant_message');
    expect(inputRecord.stop_hook_active).toBe(false);
    expect(outputRecord).toMatchObject({ decision: 'block', reason: expect.any(String) });
  } else if (eventName === 'UserPromptSubmit') {
    expect(inputRecord.prompt).toEqual(expect.any(String));
    expect(outputRecord).toMatchObject({ decision: 'block', reason: expect.any(String) });
    expect(fixtureObject(outputRecord.hookSpecificOutput).hookEventName).toBe('UserPromptSubmit');
  } else {
    throw new Error(`Unexpected Codex hook fixture event: ${eventName}`);
  }
}

runHookContractFixtureSuite({
  clientId: 'codex',
  clientDefinition,
  fixturesDir: resolve(__dirname, 'fixtures', 'hook-contracts'),
  blockingCapabilities: [CODEX_HOOK_RESPONSE_CAPABILITIES.block, CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny],
  scenarioManifest: getManifest('codex'),
  validateEventFixtures: validateCodexEventFixtures,
});
