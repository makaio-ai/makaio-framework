import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildChildEnvironment } from '../lib/agent-clients/command-construction.js';
import type { SpawnCommand } from '../lib/agent-clients/command-construction.js';
import { fixtureFilePath, writeFixture } from '../lib/agent-clients/fixtures.js';
import { getManifest } from '../lib/agent-clients/manifests.js';
import { runCommand, runScenario, writeScenarioHookConfig } from '../lib/agent-clients/runner.js';
import type { ProbeScenario, ScenarioFixture, ScenarioManifest } from '../lib/agent-clients/types.js';
import { cleanupProbeWorkspace, createProbeWorkspace } from '../lib/agent-clients/workspace.js';
import { findMissingEffectCoverage, resolveDefaultFixturesDir, runProbe } from '../test-agent-clients.js';

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
    expect(providerManifest.scenarios.length).toBeLessThanOrEqual(16);
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

  it('keeps every non-PreToolUse Claude event explicitly unobserved', () => {
    const scenarios = getManifest('claude-code').scenarios.filter(
      (scenario) => scenario.expectedEvents[0]?.eventName !== 'PreToolUse',
    );
    expect(scenarios).toHaveLength(8);
    expect(scenarios.every((scenario) => scenario.candidateExpectedStatus === 'unobserved')).toBe(true);
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
    expect(negativeControl?.sentinelOutput).toBeUndefined();
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

  it('accepts a fired hook without a sentinel only when dontAsk leaves the unapproved marker absent', async () => {
    const scenario = getManifest('claude-code').scenarios.find(
      (candidate) => candidate.id === 'pre-tool-use-unapproved-tool-negative-control',
    );
    expect(scenario).toBeDefined();
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: manifest('claude-code') });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-negative-control-'));
    try {
      const result = await runScenario({
        provider: 'claude-code',
        scenario: scenario!,
        cliVersion: '0.0.0',
        executablePath: await fakeCli(root, 'native-denies-unapproved-tool'),
        env: { PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: workspace.configDir, ANTHROPIC_API_KEY: 'test' },
        workspace,
        fixturesDir: path.join(root, 'fixtures'),
        updateFixtures: true,
      });

      expect(result.fixture.oraclePassed).toBe(true);
      expect(result.fixture.events[0]).toMatchObject({ sentinelInjected: false });
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
      schemaVersion: 3,
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
          maxScenarios: 16,
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
              schemaVersion: 3,
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
            };
            await writeFixture({ baseDir: params.fixturesDir, fixture });
            return { fixture, fixtureDiffs: [], stdout: '', stderr: '', timedOut: false };
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
          maxScenarios: 16,
          maxWallClockSeconds: 60,
        },
        {
          executablePath: '/fake/codex',
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: async (params) => ({
            fixture: {
              schemaVersion: 3,
              provider: 'codex',
              cliVersion: getManifest('codex').pinnedVersion,
              scenarioId: params.scenario.id,
              events: [],
              oracle: params.scenario.oracle,
              oraclePassed: false,
              exitCode: 1,
            },
            fixtureDiffs: [],
            stdout: '',
            stderr: '',
            timedOut: false,
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
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
