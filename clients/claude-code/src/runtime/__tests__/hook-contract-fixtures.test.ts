/**
 * Hook contract fixture tests for Claude Code.
 *
 * Delegates to the shared hook-contract fixture suite with Claude Code's
 * definition and fixture directory. See the shared module for the full
 * assertion set.
 * @packageDocumentation
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES, clientDefinition } from '../../definition.js';
import { runHookContractFixtureSuite } from '../../../../__tests__/hook-contract-fixture-suite.js';
import { getManifest } from '../../../../../scripts/lib/agent-clients/manifests.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

runHookContractFixtureSuite({
  clientId: 'claude-code',
  clientDefinition,
  fixturesDir: resolve(__dirname, 'fixtures', 'hook-contracts'),
  blockingCapabilities: [CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny],
  scenarioManifest: getManifest('claude-code'),
  validateEventFixtures: (eventName, input, output) => {
    expect(input).toMatchObject({
      hook_event_name: eventName,
      session_id: expect.any(String),
      transcript_path: null,
      cwd: expect.any(String),
      permission_mode: expect.any(String),
      tool_name: expect.any(String),
      tool_use_id: expect.any(String),
      tool_input: expect.any(Object),
    });
    expect(input).not.toHaveProperty('call_id');
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: 'deny',
        permissionDecisionReason: expect.any(String),
      },
    });
  },
});
