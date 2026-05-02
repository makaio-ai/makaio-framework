/**
 * Tests for Gemini SDK config isolation via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.
 *
 * Gemini uses an in-process library (`@google/gemini-cli-core`) rather than a
 * spawned binary. Config isolation is therefore achieved by propagating the env
 * var to `process.env` before `new Config(...)` is constructed inside the
 * `GeminiConnector` constructor.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_VAR = 'GEMINI_CLI_SYSTEM_SETTINGS_PATH';

const configHarness = vi.hoisted(() => ({
  capturedEnvValues: [] as Array<string | undefined>,
}));

vi.mock('../src/utils/create-config.js', () => ({
  createGeminiConfig: vi.fn(() => {
    configHarness.capturedEnvValues.push(process.env[ENV_VAR]);
    return {
      getSessionId: () => 'mock-gemini-session',
      modelConfigService: {
        getResolvedConfig: vi.fn(() => ({})),
        registerRuntimeModelOverride: vi.fn(),
      },
    };
  }),
  applyReasoningOverride: vi.fn(),
}));

import { GeminiConnector } from '../src/connector.js';
import { GeminiConnectorNamespace } from '../src/namespaces/index.js';

describe('GeminiConnector config isolation', () => {
  let originalEnvValue: string | undefined;

  beforeEach(() => {
    originalEnvValue = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    configHarness.capturedEnvValues.length = 0;
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalEnvValue;
    }
  });

  it('exposes GEMINI_CLI_SYSTEM_SETTINGS_PATH only during Config construction', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const isolatedPath = '/tmp/gemini-isolated-settings.json';

    new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-config-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: { [ENV_VAR]: isolatedPath },
    });

    expect(configHarness.capturedEnvValues).toEqual([isolatedPath]);
    expect(process.env[ENV_VAR]).toBeUndefined();
  });

  it('does not set GEMINI_CLI_SYSTEM_SETTINGS_PATH in process.env when absent from connector env', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();

    new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-no-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    expect(process.env[ENV_VAR]).toBeUndefined();
    expect(configHarness.capturedEnvValues).toEqual([undefined]);
  });

  it('restores a previous GEMINI_CLI_SYSTEM_SETTINGS_PATH after Config construction', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    process.env[ENV_VAR] = '/tmp/existing-gemini-settings.json';

    new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-restore-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: { [ENV_VAR]: '/tmp/isolated-gemini-settings.json' },
    });

    expect(configHarness.capturedEnvValues).toEqual(['/tmp/isolated-gemini-settings.json']);
    expect(process.env[ENV_VAR]).toBe('/tmp/existing-gemini-settings.json');
  });

  it('clears a previous GEMINI_CLI_SYSTEM_SETTINGS_PATH during Config construction when connector env omits it', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    process.env[ENV_VAR] = '/tmp/existing-gemini-settings.json';

    new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-clear-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    expect(configHarness.capturedEnvValues).toEqual([undefined]);
    expect(process.env[ENV_VAR]).toBe('/tmp/existing-gemini-settings.json');
  });
});
