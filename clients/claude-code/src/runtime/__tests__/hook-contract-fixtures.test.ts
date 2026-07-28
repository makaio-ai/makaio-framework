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
import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import { CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES, clientDefinition } from '../../definition.js';
import { runHookContractFixtureSuite } from '../../../../__tests__/hook-contract-fixture-suite.js';
import { getManifest } from '../../../../../scripts/lib/agent-clients/manifests.js';
import { createDenyEffect } from '../hook-response-contracts.js';
import { renderClaudeCodeNativeResponse } from '../hook-response-composer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Envelope keys Claude Code sends on every native hook payload. */
const COMMON_INPUT_SHAPE = {
  session_id: expect.any(String),
  transcript_path: null,
  cwd: expect.any(String),
} as const;

/**
 * Additional payload keys Claude Code sends only for tool-scoped events.
 *
 * `permission_mode` belongs here too: the probe captured it on `PreToolUse`
 * and not on `SessionStart`, which has no pending permission to describe.
 */
const TOOL_INPUT_SHAPE = {
  permission_mode: expect.any(String),
  tool_name: expect.any(String),
  tool_use_id: expect.any(String),
  tool_input: expect.any(Object),
} as const;

/**
 * Effects whose rendered output each committed output fixture must equal.
 *
 * The fixtures record the native shape of a response, so they must be checked
 * against the function that produces it rather than restated by hand — the
 * same binding the probe sentinels use. The effect payload text is incidental;
 * what this pins is the structure the renderer emits per event.
 */
const OUTPUT_FIXTURE_EFFECTS: Readonly<Record<string, ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>>> =
  {
    PreToolUse: [createDenyEffect('Tool use denied by approval handler')],
    SessionStart: [{ kind: 'context.append', value: 'Repository conventions are documented in AGENTS.md.' }],
  };

runHookContractFixtureSuite({
  clientId: 'claude-code',
  clientDefinition,
  fixturesDir: resolve(__dirname, 'fixtures', 'hook-contracts'),
  blockingCapabilities: [CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny],
  scenarioManifest: getManifest('claude-code'),
  validateEventFixtures: (eventName, input, output) => {
    const isToolScoped = eventName === 'PreToolUse';
    expect(input).toMatchObject({
      hook_event_name: eventName,
      ...COMMON_INPUT_SHAPE,
      ...(isToolScoped ? TOOL_INPUT_SHAPE : {}),
    });
    // `call_id` is the Codex spelling; Claude Code must never adopt it.
    expect(input).not.toHaveProperty('call_id');
    if (!isToolScoped) expect(input).not.toHaveProperty('tool_name');

    const effects = OUTPUT_FIXTURE_EFFECTS[eventName];
    expect(effects, `no representative effects declared for '${eventName}'`).toBeDefined();
    expect(output).toEqual(JSON.parse(renderClaudeCodeNativeResponse(eventName, effects!).stdout));
  },
});
