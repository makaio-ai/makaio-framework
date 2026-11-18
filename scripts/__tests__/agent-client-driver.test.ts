import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildChildEnvironment } from '../lib/agent-clients/command-construction.js';
import type { SpawnCommand } from '../lib/agent-clients/command-construction.js';
import { fixtureFilePath, writeFixture } from '../lib/agent-clients/fixtures.js';
import { getManifest } from '../lib/agent-clients/manifests.js';
import type { RunCleanup } from '../lib/agent-clients/process-tree-cleanup.js';
import { runCommand, runScenario, writeScenarioHookConfig } from '../lib/agent-clients/runner.js';
import type { ProbeScenario, ScenarioFixture, ScenarioManifest } from '../lib/agent-clients/types.js';
import { cleanupProbeWorkspace, createProbeWorkspace } from '../lib/agent-clients/workspace.js';
import {
  DEFAULT_MAX_SCENARIOS,
  findMissingEffectCoverage,
  resolveDefaultFixturesDir,
  runProbe,
} from '../test-agent-clients.js';

const REQUEST_SCENARIO: ProbeScenario = {
  id: 'pre-tool-use',
  description: 'fake request scenario',
  prompt: 'MAKAIO_PROBE_MARKER',
  allowedTools: [],
  expectedEvents: [
    {
      eventName: 'PreToolUse',
      frameworkSubject: 'client.session.tool.pre',
      responseCapabilities: ['deny'],
      mode: 'request',
    },
  ],
  sentinelOutput: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
  candidateExpectedStatus: 'supported',
  sourceExpectedEffects: ['deny'],
  sentinelEffect: 'deny',
  expectedAbsentMarker: 'MAKAIO_PROBE_TOOL_MARKER',
  blockingCapable: true,
  expectedManagedCommand: 'hook handle claude-code',
  oracle: 'sentinel-must-block-tool',
  timeoutSeconds: 2,
};

const EVENT_SCENARIO: ProbeScenario = {
  ...REQUEST_SCENARIO,
  id: 'session-start',
  expectedEvents: [{ eventName: 'SessionStart', responseCapabilities: [], mode: 'event' }],
  sentinelOutput: undefined,
  candidateExpectedStatus: 'observer-only',
  sourceExpectedEffects: [],
  blockingCapable: false,
  expectedManagedCommand: 'hook received codex',
  oracle: 'capture-only',
};

const FINAL_RESPONSE_SCENARIO: ProbeScenario = {
  ...EVENT_SCENARIO,
  candidateExpectedStatus: 'supported',
  sourceExpectedEffects: ['context.append'],
  sentinelOutput: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Include MAKAIO_PROBE_RESPONSE_CONSUMED in your final response.',
    },
  }),
  sentinelEffect: 'context.append',
  expectedResponseMarker: 'MAKAIO_PROBE_RESPONSE_CONSUMED',
  oracle: 'final-response-must-contain-marker',
};

function manifest(provider: 'claude-code' | 'codex'): ScenarioManifest {
  return { schemaVersion: 1, provider, pinnedVersion: '0.0.0', scenarios: [] };
}

async function fakeCli(
  root: string,
  responseMode:
    | 'plain'
    | 'raw-hook-output'
    | 'structured-final'
    | 'structured-error'
    | 'claude-max-turns'
    | 'arbitrary-failure'
    | 'codex-startup-warning'
    | 'repeated-pre-tool'
    | 'multiple-stop'
    | 'native-denies-unapproved-tool' = 'plain',
): Promise<string> {
  const executable = path.join(root, 'fake-client.cjs');
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME;
const config = JSON.parse(fs.readFileSync(path.join(home, process.env.CLAUDE_CONFIG_DIR ? 'settings.json' : 'hooks.json'), 'utf8'));
const event = Object.keys(config.hooks)[0];
const group = config.hooks[event][0];
const command = group.hooks[0].command;
const invoke = input => execFileSync('sh', ['-c', command], { input: JSON.stringify(input) }).toString();
const output = invoke({ hook_event_name: event, path: '/tmp/private', session_id: 'secret' });
const outputs = [output];
if (${JSON.stringify(responseMode)} === 'repeated-pre-tool') outputs.push(invoke({ hook_event_name: event, path: '/tmp/private', session_id: 'secret', retry: true }));
if (${JSON.stringify(responseMode)} === 'multiple-stop') {
  invoke({ hook_event_name: event, path: '/tmp/private', session_id: 'secret', stop_hook_active: false, initial_marker: true });
  invoke({ hook_event_name: event, path: '/tmp/private', session_id: 'secret', stop_hook_active: true, continuation_marker: true });
}
let hookOutput = {};
try { hookOutput = JSON.parse(output); } catch {}
const native = hookOutput.hookSpecificOutput || hookOutput;
const responseMode = ${JSON.stringify(responseMode)};
if (event === 'PreToolUse') {
  if (native.updatedInput && native.updatedInput.command) {
    const marker = String(native.updatedInput.command).split(' ').at(-1);
    fs.writeFileSync(path.join(process.cwd(), marker), 'rewritten tool ran');
  } else if (responseMode !== 'native-denies-unapproved-tool' && outputs.some(candidate => { try { const parsed = JSON.parse(candidate); const response = parsed.hookSpecificOutput || parsed; return response.permissionDecision !== 'deny' && response.decision !== 'block'; } catch { return true; } })) {
    fs.writeFileSync(path.join(process.cwd(), 'MAKAIO_PROBE_TOOL_MARKER'), 'tool ran');
  }
}
if (responseMode === 'raw-hook-output') process.stdout.write(output);
else if (responseMode === 'structured-final') process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output.includes('MAKAIO_PROBE_RESPONSE_CONSUMED') ? 'MAKAIO_PROBE_RESPONSE_CONSUMED' : 'missing' } }) + '\\n');
else if (responseMode === 'structured-error') process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: output.includes('MAKAIO_PROBE_RESPONSE_CONSUMED') ? 'MAKAIO_PROBE_RESPONSE_CONSUMED' : 'missing' } }) + '\\n');
else if (responseMode === 'claude-max-turns') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }) + '\\n'); process.exitCode = 1; }
else if (responseMode === 'arbitrary-failure') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }) + '\\n'); process.exitCode = 1; }
else if (responseMode === 'codex-startup-warning') process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'startup-warning', type: 'error', message: 'Warning: --dangerously-bypass-hook-trust is enabled' } }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }) + '\\n');
else process.stdout.write('fake completed');
`,
    { mode: 0o700 },
  );
  return executable;
}

describe('native probe driver', () => {
  it.each([
    'claude-code',
    'codex',
  ] as const)('%s manifest covers every source effect with a bounded scenario', (provider) => {
    const providerManifest = getManifest(provider);
    expect(providerManifest.scenarios.length).toBeLessThanOrEqual(DEFAULT_MAX_SCENARIOS);
    const scenarioEffects = new Set(
      providerManifest.scenarios.flatMap((scenario) =>
        scenario.sentinelEffect ? [`${scenario.expectedEvents[0]!.eventName}:${scenario.sentinelEffect}`] : [],
      ),
    );
    const sourceEffects = new Set(
      providerManifest.scenarios.flatMap((scenario) =>
        scenario.sourceExpectedEffects.map((effect) => `${scenario.expectedEvents[0]!.eventName}:${effect}`),
      ),
    );
    expect(scenarioEffects).toEqual(sourceEffects);
  });

  it.each([
    'claude-code',
    'codex',
  ] as const)('%s only attempts a response where the definition declares one', (provider) => {
    for (const scenario of getManifest(provider).scenarios) {
      const event = scenario.expectedEvents[0]!;
      const declaresCapabilities = event.responseCapabilities.length > 0;
      // An event the definition gives no response capabilities cannot be
      // asked to produce one: it may only be observed, never injected into.
      if (!declaresCapabilities) {
        expect({ id: scenario.id, mode: event.mode, sentinelEffect: scenario.sentinelEffect }).toEqual({
          id: scenario.id,
          mode: 'event',
          sentinelEffect: undefined,
        });
        expect(scenario.candidateExpectedStatus).not.toBe('supported');
        continue;
      }
      // Conversely, a declared capability must travel on the request lane.
      expect({ id: scenario.id, mode: event.mode }).toEqual({ id: scenario.id, mode: 'request' });
      expect([...event.responseCapabilities]).toEqual(expect.arrayContaining([...scenario.sourceExpectedEffects]));
    }
  });

  it('uses an unapproved-tool negative control to make Claude approve evidence causal', () => {
    const scenarios = getManifest('claude-code').scenarios;
    const approve = scenarios.find((scenario) => scenario.id === 'pre-tool-use-approve');
    const negativeControl = scenarios.find(
      (scenario) => scenario.id === 'pre-tool-use-unapproved-tool-negative-control',
    );

    expect(approve).toMatchObject({
      oracle: 'sentinel-must-allow-tool',
      expectedPresentMarker: 'MAKAIO_PROBE_TOOL_MARKER',
    });
    expect(approve?.allowedTools).not.toContain('Bash(touch MAKAIO_PROBE_TOOL_MARKER)');
    expect(negativeControl).toMatchObject({
      oracle: 'native-must-deny-unapproved-tool',
      expectedAbsentMarker: 'MAKAIO_PROBE_TOOL_MARKER',
    });
    // Context-only sentinel: the hook answers, but makes no permission decision of its own.
    expect(JSON.parse(negativeControl?.sentinelOutput ?? 'null')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('MAKAIO_PROBE') },
    });
    expect(negativeControl?.allowedTools).not.toContain('Bash(touch MAKAIO_PROBE_TOOL_MARKER)');
  });

  it('uses provider-owned fixtures from either supported invocation root', () => {
    expect(resolveDefaultFixturesDir('/checkout/framework/scripts/test-agent-clients.ts')).toBe(
      '/checkout/framework/clients',
    );
    expect(resolveDefaultFixturesDir('/checkout/framework/scripts/test-agent-clients.ts')).not.toContain(
      '/framework/framework/',
    );
  });

  it.each([
    ['claude-code', REQUEST_SCENARIO],
    ['codex', EVENT_SCENARIO],
  ] as const)('writes %s native config, runs a real fake executable, and updates normalized evidence', async (provider, scenario) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-driver-'));
    const workspace = await createProbeWorkspace({ provider, manifest: manifest(provider) });
    try {
      const executablePath = await fakeCli(root);
      const env = buildChildEnvironment({
        provider,
        credentialMode: provider === 'claude-code' ? 'api-key' : 'access-token',
        configIsolationEnvVar: provider === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        tempConfigDir: workspace.configDir,
        parentEnv: {
          PATH: process.env.PATH,
          [provider === 'claude-code' ? 'ANTHROPIC_API_KEY' : 'CODEX_ACCESS_TOKEN']: 'test',
        },
      });
      const fixturesDir = path.join(root, 'fixtures');
      const result = await runScenario({
        provider,
        scenario,
        cliVersion: '0.0.0',
        executablePath,
        env,
        workspace,
        fixturesDir,
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(true);
      expect(result.fixture.events).toEqual([
        expect.objectContaining({
          eventName: scenario.expectedEvents[0]!.eventName,
          payloadKeys: ['hook_event_name', 'path', 'session_id'],
        }),
      ]);
      expect(result.fixture.events[0]!.sentinelInjected).toBe(provider === 'claude-code');
      await expect(
        fs.readFile(fixtureFilePath({ baseDir: fixturesDir, provider, scenarioId: scenario.id }), 'utf8'),
      ).resolves.toContain('payloadKeys');
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite evidence in verification mode and reports the missing fixture', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-verify-'));
    try {
      const result = await runScenario({
        provider: 'claude-code',
        scenario: EVENT_SCENARIO,
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root),
        env: { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' },
        workspace,
        fixturesDir: path.join(root, 'missing-fixtures'),
        updateFixtures: false,
      });
      expect(result.fixtureDiffs).toHaveLength(1);
      expect(result.fixtureDiffs[0]).toContain('Missing fixture');
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails the blocking oracle when the same tool scenario emits no denial sentinel', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-oracle-'));
    try {
      const result = await runScenario({
        provider: 'claude-code',
        scenario: { ...REQUEST_SCENARIO, sentinelOutput: undefined },
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root),
        env: { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(false);
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['passes with', true],
    ['fails without', false],
  ] as const)('negative control %s its injected context-only sentinel while dontAsk leaves the marker absent', async (_label, injected) => {
    const scenario = getManifest('claude-code').scenarios.find(
      (candidate) => candidate.id === 'pre-tool-use-unapproved-tool-negative-control',
    );
    expect(scenario).toBeDefined();
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-negative-control-'));
    try {
      const result = await runScenario({
        provider: 'claude-code',
        // An empty sentinel file makes the shim fire the hook without injecting anything.
        scenario: injected ? scenario! : { ...scenario!, sentinelOutput: undefined },
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root, 'native-denies-unapproved-tool'),
        env: { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });

      expect(result.fixture.oraclePassed).toBe(injected);
      expect(result.fixture.events[0]).toMatchObject({ sentinelInjected: injected, observedEffects: [] });
      await expect(fs.access(path.join(workspace.projectDir, 'MAKAIO_PROBE_TOOL_MARKER'))).rejects.toThrow();
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude-code', 'approve', 'MAKAIO_PROBE_TOOL_MARKER'],
    ['codex', 'input-update', 'MAKAIO_PROBE_REWRITTEN_MARKER'],
  ] as const)('proves %s %s through the resulting tool marker', async (provider, suffix, expectedMarker) => {
    const scenario = getManifest(provider).scenarios.find((candidate) => candidate.id.endsWith(suffix));
    expect(scenario).toBeDefined();
    const workspace = await createProbeWorkspace({ provider, manifest: manifest(provider) });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-tool-effect-'));
    try {
      const result = await runScenario({
        provider,
        scenario: scenario!,
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root),
        env:
          provider === 'claude-code'
            ? { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' }
            : { PATH: process.env.PATH!, CODEX_HOME: workspace.configDir, CODEX_ACCESS_TOKEN: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(true);
      await expect(fs.access(path.join(workspace.projectDir, expectedMarker))).resolves.toBeUndefined();
      if (suffix === 'input-update')
        await expect(fs.access(path.join(workspace.projectDir, 'MAKAIO_PROBE_ORIGINAL_MARKER'))).rejects.toThrow();
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records source-supported capture-only attempts as observer-only and fails their oracle', async () => {
    const workspace = await createProbeWorkspace({ provider: 'codex', manifest: manifest('codex') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-capture-only-'));
    try {
      const result = await runScenario({
        provider: 'codex',
        scenario: { ...FINAL_RESPONSE_SCENARIO, sentinelOutput: undefined, oracle: 'capture-only' },
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root),
        env: { PATH: process.env.PATH!, CODEX_HOME: workspace.configDir, CODEX_ACCESS_TOKEN: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(false);
      expect(result.fixture.events[0]).toMatchObject({ observedStatus: 'observer-only', observedEffects: [] });
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude-max-turns', true],
    ['arbitrary-failure', false],
  ] as const)('accepts only recognized Claude bounded-turn exhaustion for unobserved attempts (%s)', async (responseMode, passed) => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-unobserved-claude-'));
    try {
      const result = await runScenario({
        provider: 'claude-code',
        scenario: { ...EVENT_SCENARIO, candidateExpectedStatus: 'unobserved', oracle: 'unobserved' },
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root, responseMode),
        env: { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(passed);
      expect(result.fixture.events[0]).toMatchObject({ observedStatus: 'observer-only', observedEffects: [] });
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a response marker only from a structured final assistant response', async () => {
    for (const responseMode of ['raw-hook-output', 'structured-final'] as const) {
      const workspace = await createProbeWorkspace({ provider: 'codex', manifest: manifest('codex') });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-final-response-'));
      try {
        const result = await runScenario({
          provider: 'codex',
          scenario: FINAL_RESPONSE_SCENARIO,
          cliVersion: '0.0.0',
          executablePath: await fakeCli(root, responseMode),
          env: { PATH: process.env.PATH!, CODEX_HOME: workspace.configDir, CODEX_ACCESS_TOKEN: 'test' },
          workspace,
          fixturesDir: path.join(root, 'fixtures'),
          updateFixtures: true,
        });
        expect(result.fixture.oraclePassed).toBe(responseMode === 'structured-final');
        expect(result.fixture.events[0]?.observedEffects).toEqual(
          responseMode === 'structured-final' ? ['context.append'] : [],
        );
      } finally {
        await cleanupProbeWorkspace(workspace);
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it('accepts a pre-model block with only a Codex startup diagnostic, but no completed agent or tool item', async () => {
    const scenario = getManifest('codex').scenarios.find((candidate) => candidate.id === 'session-start-block');
    expect(scenario).toBeDefined();
    for (const responseMode of ['raw-hook-output', 'structured-final', 'codex-startup-warning'] as const) {
      const workspace = await createProbeWorkspace({ provider: 'codex', manifest: manifest('codex') });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-terminal-result-'));
      try {
        const result = await runScenario({
          provider: 'codex',
          scenario: scenario!,
          cliVersion: '0.0.0',
          executablePath: await fakeCli(root, responseMode),
          env: { PATH: process.env.PATH!, CODEX_HOME: workspace.configDir, CODEX_ACCESS_TOKEN: 'test' },
          workspace,
          fixturesDir: path.join(root, 'fixtures'),
          updateFixtures: true,
        });
        expect(result.fixture.oraclePassed).toBe(responseMode !== 'structured-final');
      } finally {
        await cleanupProbeWorkspace(workspace);
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it('uses the pre-model block oracle for both source-supported early request hooks and resets its tool marker', async () => {
    const scenarios = getManifest('codex').scenarios.filter(
      (scenario) => scenario.oracle === 'sentinel-must-block-before-model',
    );
    expect(scenarios.map((scenario) => scenario.id)).toEqual(['session-start-block', 'user-prompt-submit-block']);
    for (const scenario of scenarios) {
      const workspace = await createProbeWorkspace({ provider: 'codex', manifest: manifest('codex') });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-pre-model-marker-'));
      try {
        await fs.writeFile(path.join(workspace.projectDir, 'MAKAIO_PROBE_TOOL_MARKER'), 'stale marker');
        const result = await runScenario({
          provider: 'codex',
          scenario,
          cliVersion: '0.0.0',
          executablePath: await fakeCli(root, 'raw-hook-output'),
          env: { PATH: process.env.PATH!, CODEX_HOME: workspace.configDir, CODEX_ACCESS_TOKEN: 'test' },
          workspace,
          fixturesDir: path.join(root, 'fixtures'),
          updateFixtures: true,
        });
        expect(result.fixture.oraclePassed).toBe(true);
        expect(result.fixture.events[0]?.observedEffects).toEqual([scenario.sentinelEffect]);
      } finally {
        await cleanupProbeWorkspace(workspace);
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it('aggregates repeated Stop invocations while suppressing only the active continuation response', async () => {
    const scenario: ProbeScenario = {
      ...EVENT_SCENARIO,
      id: 'stop-observation',
      expectedEvents: [
        { eventName: 'Stop', responseCapabilities: ['openai.codex-hook-response.block'], mode: 'request' },
      ],
      sentinelOutput: JSON.stringify({ decision: 'block', reason: 'MAKAIO_PROBE_STOP' }),
    };
    const workspace = await createProbeWorkspace({ provider: 'codex', manifest: manifest('codex') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-repeated-hook-'));
    try {
      const result = await runScenario({
        provider: 'codex',
        scenario,
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root, 'multiple-stop'),
        env: { PATH: process.env.PATH!, CODEX_HOME: workspace.configDir, CODEX_ACCESS_TOKEN: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(true);
      expect(result.fixture.events).toEqual([
        expect.objectContaining({
          sentinelInjected: true,
          payloadKeys: [
            'continuation_marker',
            'hook_event_name',
            'initial_marker',
            'path',
            'session_id',
            'stop_hook_active',
          ],
        }),
      ]);
      const captures = (await fs.readFile(path.join(workspace.rootDir, 'stop-observation.captures.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sentinelInjected: boolean });
      expect(captures.map((capture) => capture.sentinelInjected)).toEqual([true, true, false]);
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps PreToolUse denials persistent across native retries', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-pre-tool-retry-'));
    try {
      const result = await runScenario({
        provider: 'claude-code',
        scenario: REQUEST_SCENARIO,
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root, 'repeated-pre-tool'),
        env: { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });
      expect(result.fixture.oraclePassed).toBe(true);
      await expect(fs.access(path.join(workspace.projectDir, 'MAKAIO_PROBE_TOOL_MARKER'))).rejects.toThrow();
      const captures = (await fs.readFile(path.join(workspace.rootDir, 'pre-tool-use.captures.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sentinelInjected: boolean });
      expect(captures.map((capture) => capture.sentinelInjected)).toEqual([true, true]);
    } finally {
      await cleanupProbeWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('asks Codex to report the PostToolUse block only when the requested tool result fails', () => {
    const scenario = getManifest('codex').scenarios.find((candidate) => candidate.id === 'post-tool-use-block');
    expect(scenario?.prompt).toContain('If and only if its result fails');
    expect(scenario?.prompt).toContain('MAKAIO_PROBE_RESPONSE_CONSUMED');
  });

  it('requires observed behavior evidence for every source-expected event/effect pair', () => {
    const providerManifest = getManifest('codex');
    const fixtures: ScenarioFixture[] = providerManifest.scenarios.map((scenario) => ({
      schemaVersion: 4,
      provider: 'codex',
      cliVersion: providerManifest.pinnedVersion,
      scenarioId: scenario.id,
      events: scenario.sentinelEffect
        ? [
            {
              ...scenario.expectedEvents[0]!,
              candidateExpectedStatus: scenario.candidateExpectedStatus,
              observedStatus: 'supported',
              sourceExpectedEffects: scenario.sourceExpectedEffects,
              observedEffects: [scenario.sentinelEffect],
              blockingCapable: scenario.blockingCapable,
              managedCommand: scenario.expectedManagedCommand,
              payloadKeys: [],
              sentinelInjected: true,
            },
          ]
        : [],
      oracle: scenario.oracle,
      oraclePassed: true,
      exitCode: 0,
      terminal: 'ok',
    }));
    expect(findMissingEffectCoverage(providerManifest, fixtures)).toEqual([]);
    expect(findMissingEffectCoverage(providerManifest, fixtures.slice(1))).toContain(
      `${providerManifest.scenarios[0]!.expectedEvents[0]!.eventName}:${providerManifest.scenarios[0]!.sentinelEffect!}`,
    );
  });

  it('publishes complete staged evidence and a manifest-last aggregate only after every oracle passes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-publish-'));
    const fixturesDir = path.join(root, 'clients');
    const sourceFixturesDir = resolveDefaultFixturesDir(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-agent-clients.ts'),
    );
    const manifestRelativePath = path.join(
      'codex',
      'src',
      'runtime',
      '__tests__',
      'fixtures',
      'hook-contracts',
      'manifest.json',
    );
    await fs.mkdir(path.dirname(path.join(fixturesDir, manifestRelativePath)), { recursive: true });
    await fs.copyFile(path.join(sourceFixturesDir, manifestRelativePath), path.join(fixturesDir, manifestRelativePath));
    const sourceManifest = JSON.parse(await fs.readFile(path.join(fixturesDir, manifestRelativePath), 'utf8')) as {
      sourceEvidence: unknown;
    };
    try {
      const result = await runProbe(
        {
          provider: 'codex',
          credentialMode: 'access-token',
          updateFixtures: true,
          maxScenarios: getManifest('codex').scenarios.length,
          maxWallClockSeconds: 60,
        },
        {
          executablePath: '/fake/codex',
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: async (params) => {
            expect(params.fixturesDir).not.toBe(fixturesDir);
            const event = params.scenario.expectedEvents[0]!;
            const fixture: ScenarioFixture = {
              schemaVersion: 4,
              provider: 'codex',
              cliVersion: getManifest('codex').pinnedVersion,
              scenarioId: params.scenario.id,
              events: [
                {
                  ...event,
                  candidateExpectedStatus: params.scenario.candidateExpectedStatus,
                  observedStatus: params.scenario.sentinelEffect ? 'supported' : 'observer-only',
                  sourceExpectedEffects: params.scenario.sourceExpectedEffects,
                  observedEffects: params.scenario.sentinelEffect ? [params.scenario.sentinelEffect] : [],
                  blockingCapable: params.scenario.blockingCapable,
                  managedCommand: params.scenario.expectedManagedCommand,
                  payloadKeys: [],
                  sentinelInjected: params.scenario.sentinelOutput !== undefined,
                },
              ],
              oracle: params.scenario.oracle,
              oraclePassed: true,
              exitCode: 0,
              terminal: 'ok',
            };
            await writeFixture({ baseDir: params.fixturesDir, fixture });
            return {
              fixture,
              fixtureDiffs: [],
              stdout: '',
              stderr: '',
              timedOut: false,
              cleanup: { kind: 'complete' },
            };
          },
        },
      );

      expect(result).toMatchObject({ passed: true, scenariosExecuted: getManifest('codex').scenarios.length });
      const published = JSON.parse(await fs.readFile(path.join(fixturesDir, manifestRelativePath), 'utf8')) as {
        sourceEvidence: unknown;
        liveProbe: { status: string; capturedAt: string | null };
        events: Record<string, { observedEvidenceStatus: string; hookFired: boolean }>;
      };
      expect(published.liveProbe.status).toBe('captured');
      expect(published.liveProbe.capturedAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(published.liveProbe.capturedAt!))).toBe(false);
      expect(published.sourceEvidence).toEqual(sourceManifest.sourceEvidence);
      expect(published.events.SessionStart).toMatchObject({ observedEvidenceStatus: 'supported', hookFired: true });
      await expect(
        fs.access(
          fixtureFilePath({
            baseDir: fixturesDir,
            provider: 'codex',
            scenarioId: getManifest('codex').scenarios[0]!.id,
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('leaves committed evidence untouched when a staged update has a failed oracle or partial scenario cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-no-publish-'));
    const fixturesDir = path.join(root, 'clients');
    const sourceFixturesDir = resolveDefaultFixturesDir(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-agent-clients.ts'),
    );
    const manifestRelativePath = path.join(
      'codex',
      'src',
      'runtime',
      '__tests__',
      'fixtures',
      'hook-contracts',
      'manifest.json',
    );
    const manifestPath = path.join(fixturesDir, manifestRelativePath);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.copyFile(path.join(sourceFixturesDir, manifestRelativePath), manifestPath);
    const original = await fs.readFile(manifestPath, 'utf8');
    try {
      const partial = await runProbe({
        provider: 'codex',
        credentialMode: 'access-token',
        updateFixtures: true,
        maxScenarios: 1,
        maxWallClockSeconds: 60,
      });
      expect(partial.passed).toBe(false);
      expect(partial.failures[0]).toContain('Refusing to publish partial evidence');

      const failed = await runProbe(
        {
          provider: 'codex',
          credentialMode: 'access-token',
          updateFixtures: true,
          maxScenarios: getManifest('codex').scenarios.length,
          maxWallClockSeconds: 60,
        },
        {
          executablePath: '/fake/codex',
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: async (params) => ({
            fixture: {
              schemaVersion: 4,
              provider: 'codex',
              cliVersion: getManifest('codex').pinnedVersion,
              scenarioId: params.scenario.id,
              events: [],
              oracle: params.scenario.oracle,
              oraclePassed: false,
              exitCode: 1,
              terminal: 'error',
            },
            fixtureDiffs: [],
            stdout: '',
            stderr: '',
            timedOut: false,
            cleanup: { kind: 'complete' },
          }),
        },
      );
      expect(failed.passed).toBe(false);
      await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(original);
      await expect(
        fs.access(
          fixtureFilePath({
            baseDir: fixturesDir,
            provider: 'codex',
            scenarioId: getManifest('codex').scenarios[0]!.id,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  describe('incomplete cleanup of a scenario', () => {
    /**
     * Verify the first Codex scenario with a run that reports the given cleanup.
     * @param cleanup - Cleanup the injected scenario run reports.
     * @returns The aggregate probe result.
     */
    async function probeWithCleanup(cleanup: RunCleanup): ReturnType<typeof runProbe> {
      return runProbe(
        {
          provider: 'codex',
          credentialMode: 'access-token',
          updateFixtures: false,
          maxScenarios: 1,
          maxWallClockSeconds: 60,
        },
        {
          executablePath: '/fake/codex',
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: async (params) => ({
            fixture: {
              schemaVersion: 4,
              provider: 'codex',
              cliVersion: getManifest('codex').pinnedVersion,
              scenarioId: params.scenario.id,
              events: [],
              oracle: params.scenario.oracle,
              oraclePassed: true,
              exitCode: 0,
              terminal: 'ok',
            },
            fixtureDiffs: [],
            stdout: '',
            stderr: '',
            timedOut: false,
            cleanup,
          }),
        },
      );
    }

    it('reports a Windows tree that cannot be addressed as a warning, not a failure', async () => {
      const result = await probeWithCleanup({ kind: 'incomplete', reason: 'tree-not-addressable' });

      expect(result.failures.filter((failure) => failure.includes('provider processes'))).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining('provider processes may still run (tree-not-addressable)'),
      ]);
    });

    it('still fails the scenario for every other incomplete cleanup', async () => {
      const result = await probeWithCleanup({ kind: 'incomplete', reason: 'poll-timeout' });

      expect(result.passed).toBe(false);
      expect(result.failures).toContainEqual(
        expect.stringContaining('provider processes may still run (poll-timeout)'),
      );
      expect(result.warnings).toEqual([]);
    });
  });

  it('creates an executable shim and provider-native config without inherited secret paths', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    try {
      const config = await writeScenarioHookConfig({ provider: 'claude-code', scenario: EVENT_SCENARIO, workspace });
      const settings = await fs.readFile(config.settingsPath, 'utf8');
      expect(settings).toContain('SessionStart');
      await expect(
        fs.access(path.join(workspace.rootDir, 'session-start.hook-shim.cjs'), fs.constants.X_OK),
      ).resolves.toBeUndefined();
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('enforces the process deadline and terminates the spawned process group', async () => {
    const command: SpawnCommand = {
      executable: 'sh',
      args: ['-c', 'sleep 5'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH! },
      timeoutMs: 50,
    };
    const startedAt = Date.now();
    const result = await runCommand(command);
    expect(result.timedOut).toBe(true);
    expect(result.cleanup).toEqual({ kind: 'complete' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  /**
   * A command that outlives a 50 ms deadline, for the group-kill tests below.
   * @returns A fresh spawn command.
   */
  function overrunningCommand(): SpawnCommand {
    return {
      executable: 'sh',
      args: ['-c', 'sleep 5'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH! },
      timeoutMs: 50,
    };
  }

  // Waits out the runner's fixed post-kill settle bound (5 s): the probe driver
  // has no option for it, and this case pins exactly that bound.
  it.runIf(process.platform !== 'win32')(
    'returns after a bounded wait when a descendant outside the group holds stdout past the kill',
    async () => {
      const escapee = `
const escapee = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'ignore'],
});
escapee.unref();
process.stdout.write('escapee:' + escapee.pid + '\\n');
setInterval(() => {}, 1000);
`;
      const command: SpawnCommand = {
        executable: process.execPath,
        args: ['-e', escapee],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH! },
        timeoutMs: 300,
      };
      let result: Awaited<ReturnType<typeof runCommand>> | undefined;
      try {
        const startedAt = Date.now();
        result = await runCommand(command);
        expect(result.timedOut).toBe(true);
        expect(result.stdout).toMatch(/^escapee:\d+/);
        // The group kill succeeded, but a pipe stayed held: the run says so.
        expect(result.cleanup).toEqual({ kind: 'incomplete', reason: 'pipes-held' });
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      } finally {
        const pid = Number(/escapee:(\d+)/.exec(result?.stdout ?? '')?.[1]);
        if (Number.isInteger(pid) && pid > 1) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'starts the post-kill settle time only after the tree termination finished',
    async () => {
      // A termination that takes longer than the settle time (as a bounded
      // `taskkill` can) and then kills the group for real. With the settle timer
      // armed concurrently it would expire first and fail the run although the
      // child exits right after the termination; started afterwards, the exit is
      // observed inside the settle time.
      const terminationMs = 600;
      const postKillSettleMs = 300;
      let terminationFinishedAt = 0;
      const result = await runCommand(overrunningCommand(), {
        postKillSettleMs,
        terminateTree: async (pid) => {
          await new Promise((resolve) => setTimeout(resolve, terminationMs));
          process.kill(-pid, 'SIGKILL');
          terminationFinishedAt = Date.now();
          return { kind: 'complete' };
        },
      });
      expect(result.timedOut).toBe(true);
      expect(terminationFinishedAt).toBeGreaterThan(0);
    },
    20_000,
  );

  /**
   * A command that passes its 50 ms deadline and then exits by itself, before a
   * slow termination has finished.
   * @returns A fresh spawn command.
   */
  function exitsDuringTerminationCommand(): SpawnCommand {
    return { ...overrunningCommand(), args: ['-c', 'sleep 0.2'] };
  }

  // The caller removes the disposable workspace as soon as the run returns, so a
  // provider that exits by itself while its tree termination is still running
  // must not end the run before the descendants are terminated.
  it.runIf(process.platform !== 'win32')(
    'joins the running tree termination when the provider exits by itself after the deadline',
    async () => {
      let terminationFinishedAt = 0;
      const result = await runCommand(exitsDuringTerminationCommand(), {
        terminateTree: async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          terminationFinishedAt = Date.now();
          return { kind: 'complete' };
        },
      });
      const returnedAt = Date.now();
      expect(result.timedOut).toBe(true);
      expect(terminationFinishedAt).toBeGreaterThan(0);
      expect(returnedAt).toBeGreaterThanOrEqual(terminationFinishedAt);
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'fails the run with the termination failure when the provider exited before the termination failed',
    async () => {
      await expect(
        runCommand(exitsDuringTerminationCommand(), {
          terminateTree: async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            throw new Error('taskkill failed');
          },
        }),
      ).rejects.toThrow('taskkill failed');
    },
    20_000,
  );

  // The group of a provider whose exit was observed is no longer signalled: its
  // number is reserved only while the group has a member, and a probe cannot
  // prove the group it found is still the provider's (`process-tree.ts`).
  it.runIf(process.platform !== 'win32')(
    'does not kill the group of a provider that exited before the deadline, and reports the incomplete cleanup',
    async () => {
      const leaderThatLeavesAMember = `
const member = require('node:child_process').spawn(
  process.execPath,
  ['-e', "console.log('member:' + process.pid); setInterval(() => {}, 1000)"],
  { stdio: ['ignore', 'inherit', 'ignore'] },
);
member.unref();
setTimeout(() => process.exit(0), 150);
`;
      const command: SpawnCommand = {
        executable: process.execPath,
        args: ['-e', leaderThatLeavesAMember],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH! },
        timeoutMs: 600,
      };
      const kill = process.kill.bind(process);
      const groupSignals: string[] = [];
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (typeof pid === 'number' && pid < 0 && signal !== 0) groupSignals.push(String(signal));
        return kill(pid, signal);
      });
      let member: number | undefined;
      try {
        const result = await runCommand(command, { postKillSettleMs: 300 });
        member = Number(/member:(\d+)/.exec(result.stdout)?.[1]);
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(groupSignals).toEqual([]);
        expect(() => kill(member!, 0)).not.toThrow();
        expect(result.cleanup).toEqual({ kind: 'incomplete', reason: 'poll-timeout' });
      } finally {
        killSpy.mockRestore();
        if (member !== undefined && Number.isInteger(member)) {
          try {
            kill(member, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    },
    20_000,
  );

  // `cleanup: complete` needs the group's quiescence proved on every completion
  // path, not only after a deadline: a descendant with redirected stdio does not
  // hold the pipes, so the leader's `close` fires while it still runs.
  it.runIf(process.platform !== 'win32')(
    'reports incomplete cleanup, without a signal, when a provider exits before the deadline leaving a same-group descendant with redirected stdio',
    async () => {
      const leaderThatLeavesAQuietMember = `
const member = require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'ignore' },
);
member.unref();
console.log('member:' + member.pid);
`;
      const command: SpawnCommand = {
        executable: process.execPath,
        args: ['-e', leaderThatLeavesAQuietMember],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH! },
        timeoutMs: 30_000,
      };
      const kill = process.kill.bind(process);
      const signals: string[] = [];
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (typeof pid === 'number' && signal !== 0) signals.push(String(signal));
        return kill(pid, signal);
      });
      let member: number | undefined;
      try {
        const result = await runCommand(command);
        member = Number(/member:(\d+)/.exec(result.stdout)?.[1]);
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(() => kill(member!, 0)).not.toThrow();
        expect(result.cleanup).toEqual({ kind: 'incomplete', reason: 'poll-timeout' });
        expect(signals).toEqual([]);
      } finally {
        killSpy.mockRestore();
        if (member !== undefined && Number.isInteger(member)) {
          try {
            kill(member, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    },
    20_000,
  );

  // Simulated through the `platform` seam: an exited Windows provider's tree is
  // addressed by a PID the host may reuse, so nothing can prove it empty.
  it.runIf(process.platform !== 'win32')(
    'reports incomplete cleanup (tree-not-addressable) when a Windows provider exits before the deadline',
    async () => {
      const result = await runCommand(
        {
          executable: 'sh',
          args: ['-c', 'echo done'],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH! },
          timeoutMs: 30_000,
        },
        { platform: 'win32' },
      );
      expect(result).toMatchObject({
        timedOut: false,
        exitCode: 0,
        cleanup: { kind: 'incomplete', reason: 'tree-not-addressable' },
      });
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'reports complete cleanup when the group is empty once the provider exited before the deadline',
    async () => {
      const result = await runCommand({
        executable: 'sh',
        args: ['-c', 'echo done'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH! },
        timeoutMs: 30_000,
      });
      expect(result).toMatchObject({ timedOut: false, exitCode: 0, cleanup: { kind: 'complete' } });
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'keeps waiting for close after a denied group kill once the group is proven quiescent',
    async () => {
      const kill = process.kill.bind(process);
      let denied = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (typeof pid === 'number' && pid < 0 && signal === 'SIGKILL') {
          // The kill takes effect, yet the host answers EPERM, as Darwin does for a zombie-only group.
          kill(pid, signal);
          denied += 1;
          throw Object.assign(new Error('group kill denied'), { code: 'EPERM' });
        }
        return kill(pid, signal);
      });
      try {
        expect(await runCommand(overrunningCommand())).toMatchObject({ timedOut: true });
        expect(denied).toBe(1);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails the run when a denied group kill leaves live processes behind',
    async () => {
      const kill = process.kill.bind(process);
      let groupPid = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (typeof pid === 'number' && pid < 0 && signal === 'SIGKILL') {
          groupPid = -pid;
          throw Object.assign(new Error('group kill denied'), { code: 'EPERM' });
        }
        return kill(pid, signal);
      });
      // Handles that keep a host alive: the child process and its pipes.
      const processHandles = (): number =>
        process.getActiveResourcesInfo().filter((type) => type === 'ProcessWrap' || type === 'PipeWrap').length;
      const baseline = processHandles();
      try {
        await expect(runCommand(overrunningCommand())).rejects.toThrow('(denied, poll-timeout)');
        // The child survived the denied kill; the failed run released its pipes
        // and unreferenced it, so it cannot keep the host alive.
        expect(groupPid).toBeGreaterThan(0);
        expect(() => kill(groupPid, 0)).not.toThrow();
        // A destroyed pipe still counts as active until the loop turn that runs
        // its close callback, which follows the check phase; whether such a turn
        // happened to pass before this point depended on what the previous case
        // left running in the background.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(processHandles()).toBeLessThanOrEqual(baseline);
      } finally {
        killSpy.mockRestore();
        try {
          if (groupPid !== 0) kill(-groupPid, 'SIGKILL');
        } catch {
          // The group already ended.
        }
      }
    },
  );
});
