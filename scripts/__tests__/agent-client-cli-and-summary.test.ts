import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getManifest } from '../lib/agent-clients/manifests.js';
import { summarizeNativeResult } from '../lib/agent-clients/native-result-summary.js';
import { writeScenarioHookConfig } from '../lib/agent-clients/runner.js';
import type { ProbeScenario, ScenarioManifest } from '../lib/agent-clients/types.js';
import { cleanupProbeWorkspace, createProbeWorkspace } from '../lib/agent-clients/workspace.js';
import { parseProbeArgs, plannedScenarios, selectScenarios } from '../test-agent-clients.js';

const SCENARIO: ProbeScenario = {
  id: 'post-tool-use',
  description: 'fake post-tool-use scenario',
  prompt: 'MAKAIO_PROBE_MARKER',
  allowedTools: [],
  expectedEvents: [
    {
      eventName: 'PostToolUse',
      frameworkSubject: 'client.session.tool.post',
      responseCapabilities: [],
      mode: 'event',
    },
  ],
  candidateExpectedStatus: 'observer-only',
  sourceExpectedEffects: [],
  blockingCapable: false,
  expectedManagedCommand: 'hook received claude-code',
  oracle: 'capture-only',
  timeoutSeconds: 45,
};

function emptyManifest(provider: 'claude-code' | 'codex'): ScenarioManifest {
  return { schemaVersion: 1, provider, pinnedVersion: '0.0.0', scenarios: [] };
}

function manifestWith(ids: readonly string[]): ScenarioManifest {
  return { ...emptyManifest('claude-code'), scenarios: ids.map((id) => ({ ...SCENARIO, id })) };
}

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly { readonly type: string; readonly timeout?: number; readonly timeoutSec?: number }[];
}

async function readHookEntries(settingsPath: string, eventName: string): Promise<readonly HookEntry[]> {
  const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
    hooks: Record<string, readonly HookEntry[]>;
  };
  return parsed.hooks[eventName]!;
}

describe('summarizeNativeResult', () => {
  const claudeResult = {
    type: 'result',
    duration_ms: 12_345,
    duration_api_ms: 11_000,
    total_cost_usd: 0.0421,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000 },
    modelUsage: { 'claude-model': { inputTokens: 1200, outputTokens: 300 } },
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    permission_denials: [
      { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'cat SECRET_DENIED_INPUT' } },
      { tool_name: 'mcp__probe__write', tool_use_id: 'toolu_2', tool_input: { path: 'SECRET_DENIED_PATH' } },
    ],
    result: 'Done.',
  };

  it('projects the decisive scalar fields even when usage and cost fields come first', () => {
    const summary = summarizeNativeResult(JSON.stringify(claudeResult), '');
    expect(summary).toContain('subtype="success"');
    expect(summary).toContain('is_error=false');
    expect(summary).toContain('num_turns=3');
    expect(summary).toContain('stop_reason="end_turn"');
    expect(summary).toContain('terminal_reason="completed"');
    expect(summary).toContain('permission_denials=2 [Bash, mcp__probe__write]');
    expect(summary).toContain('result="Done."');
    expect(summary).not.toContain('total_cost_usd');
    expect(summary).not.toContain('usage');
    expect(summary).not.toContain('duration_ms');
  });

  it('never includes the tool_input of a permission denial', () => {
    const summary = summarizeNativeResult(JSON.stringify(claudeResult), '');
    expect(summary).not.toContain('tool_input');
    expect(summary).not.toContain('SECRET_DENIED_INPUT');
    expect(summary).not.toContain('SECRET_DENIED_PATH');
  });

  it('reports an empty denial list as a zero count without a name list', () => {
    const summary = summarizeNativeResult(JSON.stringify({ ...claudeResult, permission_denials: [] }), '');
    expect(summary).toContain('permission_denials=0');
    expect(summary).not.toContain('permission_denials=0 [');
  });

  it('cuts a result text longer than 300 characters with an ellipsis', () => {
    const longText = 'x'.repeat(350);
    const summary = summarizeNativeResult(JSON.stringify({ ...claudeResult, result: longText }), '');
    expect(summary).toContain(`result="${'x'.repeat(300)}…"`);
    expect(summary).not.toContain('x'.repeat(301));
  });

  it('keeps a result text of exactly 300 characters without an ellipsis', () => {
    const text = 'y'.repeat(300);
    const summary = summarizeNativeResult(JSON.stringify({ ...claudeResult, result: text }), '');
    expect(summary).toContain(`result="${text}"`);
    expect(summary).not.toContain('…');
  });

  it('appends redacted stderr to a parsed result', () => {
    const summary = summarizeNativeResult(JSON.stringify(claudeResult), 'warning at /Users/someone/file');
    expect(summary).toContain('stderr="warning at [redacted]"');
  });

  it('finds the result line in JSONL stdout', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ ...claudeResult, subtype: 'error_max_turns', is_error: true }),
    ].join('\n');
    const summary = summarizeNativeResult(stdout, '');
    expect(summary).toContain('subtype="error_max_turns"');
    expect(summary).toContain('is_error=true');
  });

  it('falls back to the redacted raw slice for non-JSON stdout', () => {
    // Path redaction runs to the end of the line, so the path is followed by a newline.
    const summary = summarizeNativeResult('Error:   CLI crashed at /Users/someone/secret/path\nretry later', 'boom\n');
    expect(summary).toBe('Error: CLI crashed at [redacted] retry later boom');
  });

  it('bounds the raw fallback to 800 characters', () => {
    const summary = summarizeNativeResult('z'.repeat(2000), '');
    expect(summary).toHaveLength(800);
  });

  it('falls back to the raw slice for JSONL stdout without a result line', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', num_turns: 9 }),
    ].join('\n');
    const summary = summarizeNativeResult(stdout, '');
    expect(summary).not.toContain('num_turns=9');
    expect(summary).toContain('"type":"system"');
    expect(summary).toContain('"type":"assistant"');
  });

  it('returns an empty string when there is nothing to report', () => {
    expect(summarizeNativeResult('', '')).toBe('');
  });
});

describe('parseProbeArgs --scenario', () => {
  const codexIds = getManifest('codex').scenarios.map((scenario) => scenario.id);

  it('has at least two Codex scenarios to filter', () => {
    expect(codexIds.length).toBeGreaterThanOrEqual(2);
  });

  it('collects repeated --scenario ids', () => {
    const [first, second] = codexIds;
    const options = parseProbeArgs(['--provider', 'codex', '--scenario', first!, '--scenario', second!], {});
    expect(options.scenarioIds).toEqual([first, second]);
  });

  it('throws on an unknown id and lists the valid ids', () => {
    expect(() => parseProbeArgs(['--provider', 'codex', '--scenario', 'no-such-scenario'], {})).toThrow(
      `Unknown --scenario for codex: no-such-scenario. Valid ids: ${codexIds.join(', ')}`,
    );
  });

  it('throws when --scenario has no value', () => {
    expect(() => parseProbeArgs(['--provider', 'codex', '--scenario'], {})).toThrow(
      '--scenario requires a scenario id',
    );
  });

  it('throws when --scenario is followed by another option instead of an id', () => {
    expect(() => parseProbeArgs(['--provider', 'codex', '--scenario', '--update-fixtures'], {})).toThrow(
      '--scenario requires a scenario id',
    );
  });

  it('omits scenarioIds without --scenario', () => {
    const options = parseProbeArgs(['--provider', 'codex'], {});
    expect(options.scenarioIds).toBeUndefined();
    expect('scenarioIds' in options).toBe(false);
  });
});

describe('selectScenarios', () => {
  const manifest = manifestWith(['alpha', 'beta', 'gamma']);

  it('returns every scenario when no ids are given', () => {
    expect(selectScenarios(manifest, undefined)).toBe(manifest.scenarios);
  });

  it('keeps manifest order regardless of request order', () => {
    expect(selectScenarios(manifest, ['gamma', 'alpha']).map((scenario) => scenario.id)).toEqual(['alpha', 'gamma']);
  });

  it('collapses duplicate ids', () => {
    expect(selectScenarios(manifest, ['beta', 'beta', 'alpha', 'beta']).map((scenario) => scenario.id)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('throws on unknown ids and lists the valid ids', () => {
    expect(() => selectScenarios(manifest, ['alpha', 'delta'])).toThrow(
      'Unknown --scenario for claude-code: delta. Valid ids: alpha, beta, gamma',
    );
  });
});

describe('plannedScenarios', () => {
  const manifest = getManifest('claude-code');
  const ids = manifest.scenarios.map((scenario) => scenario.id);

  it('has enough Claude scenarios to filter and cap', () => {
    expect(ids.length).toBeGreaterThanOrEqual(5);
  });

  it('applies the cap after the filter and keeps manifest order', () => {
    const requested = [ids[4]!, ids[1]!, ids[3]!];
    const planned = plannedScenarios(manifest, { scenarioIds: requested, maxScenarios: 2 });
    expect(planned.map((scenario) => scenario.id)).toEqual([ids[1], ids[3]]);
  });

  it('returns the first maxScenarios scenarios in manifest order without a filter', () => {
    const planned = plannedScenarios(manifest, { maxScenarios: 3 });
    expect(planned.map((scenario) => scenario.id)).toEqual(ids.slice(0, 3));
  });

  it('throws on an unknown id and lists the valid ids', () => {
    expect(() => plannedScenarios(manifest, { scenarioIds: [ids[0]!, 'no-such-scenario'], maxScenarios: 1 })).toThrow(
      `Unknown --scenario for claude-code: no-such-scenario. Valid ids: ${ids.join(', ')}`,
    );
  });
});

describe('writeScenarioHookConfig', () => {
  it('writes the Claude hook timeout in seconds', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: emptyManifest('claude-code') });
    try {
      const config = await writeScenarioHookConfig({ provider: 'claude-code', scenario: SCENARIO, workspace });
      const [entry] = await readHookEntries(config.settingsPath, 'PostToolUse');
      expect(entry!.hooks[0]!.timeout).toBe(SCENARIO.timeoutSeconds);
      expect(entry!.hooks[0]!.timeout).not.toBe(SCENARIO.timeoutSeconds * 1000);
      expect(entry!.hooks[0]!.timeoutSec).toBeUndefined();
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('writes the Codex hook timeoutSec in seconds', async () => {
    const workspace = await createProbeWorkspace({ provider: 'codex', manifest: emptyManifest('codex') });
    try {
      const config = await writeScenarioHookConfig({ provider: 'codex', scenario: SCENARIO, workspace });
      const [entry] = await readHookEntries(config.settingsPath, 'PostToolUse');
      expect(entry!.hooks[0]!.timeoutSec).toBe(SCENARIO.timeoutSeconds);
      expect(entry!.hooks[0]!.timeout).toBeUndefined();
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('sets the Claude matcher only when hookMatcher is declared', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: emptyManifest('claude-code') });
    try {
      const withMatcher = await writeScenarioHookConfig({
        provider: 'claude-code',
        scenario: { ...SCENARIO, id: 'with-matcher', hookMatcher: 'mcp__probe__.*' },
        workspace,
      });
      const [matched] = await readHookEntries(withMatcher.settingsPath, 'PostToolUse');
      expect(matched!.matcher).toBe('mcp__probe__.*');

      const withoutMatcher = await writeScenarioHookConfig({
        provider: 'claude-code',
        scenario: { ...SCENARIO, id: 'without-matcher' },
        workspace,
      });
      const [unmatched] = await readHookEntries(withoutMatcher.settingsPath, 'PostToolUse');
      expect('matcher' in unmatched!).toBe(false);
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('writes an mcp-config file with the declared servers and returns its path', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: emptyManifest('claude-code') });
    try {
      const mcpServers = {
        probe: { command: 'node', args: ['probe-mcp-server.js', '--flag'], alwaysLoad: true },
      } as const;
      const config = await writeScenarioHookConfig({
        provider: 'claude-code',
        scenario: { ...SCENARIO, mcpServers },
        workspace,
      });
      expect(config.mcpConfigPath).toBeDefined();
      const written = JSON.parse(await fs.readFile(config.mcpConfigPath!, 'utf8')) as unknown;
      expect(written).toEqual({ mcpServers });
      expect((written as { mcpServers: { probe: { alwaysLoad: boolean } } }).mcpServers.probe.alwaysLoad).toBe(true);
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('returns no mcp-config path when no servers are declared', async () => {
    const workspace = await createProbeWorkspace({ provider: 'claude-code', manifest: emptyManifest('claude-code') });
    try {
      const config = await writeScenarioHookConfig({ provider: 'claude-code', scenario: SCENARIO, workspace });
      expect(config.mcpConfigPath).toBeUndefined();
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('sets the Codex hooks.json group matcher only when hookMatcher is declared', async () => {
    const workspace = await createProbeWorkspace({ provider: 'codex', manifest: emptyManifest('codex') });
    try {
      const withMatcher = await writeScenarioHookConfig({
        provider: 'codex',
        scenario: { ...SCENARIO, id: 'with-matcher', hookMatcher: 'mcp__probe__.*' },
        workspace,
      });
      const [matched] = await readHookEntries(withMatcher.settingsPath, 'PostToolUse');
      expect(matched!.matcher).toBe('mcp__probe__.*');
      expect(matched!.hooks[0]!.timeoutSec).toBe(SCENARIO.timeoutSeconds);

      const withoutMatcher = await writeScenarioHookConfig({
        provider: 'codex',
        scenario: { ...SCENARIO, id: 'without-matcher' },
        workspace,
      });
      const [unmatched] = await readHookEntries(withoutMatcher.settingsPath, 'PostToolUse');
      expect('matcher' in unmatched!).toBe(false);
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });

  it('writes no mcp-config file for a Codex scenario that declares servers', async () => {
    const workspace = await createProbeWorkspace({ provider: 'codex', manifest: emptyManifest('codex') });
    try {
      const config = await writeScenarioHookConfig({
        provider: 'codex',
        scenario: { ...SCENARIO, mcpServers: { probe: { command: 'node', args: ['probe-mcp-server.js'] } } },
        workspace,
      });
      expect(config.mcpConfigPath).toBeUndefined();
      const written = await fs.readdir(workspace.rootDir);
      expect(written.filter((name) => name.endsWith('.mcp-config.json'))).toEqual([]);
    } finally {
      await cleanupProbeWorkspace(workspace);
    }
  });
});
