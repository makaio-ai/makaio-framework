/**
 * Tests for Gemini SDK config isolation via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.
 *
 * Gemini uses an in-process library (`@google/gemini-cli-core`) rather than a
 * spawned binary. Config construction must therefore happen inside the
 * connector's serialized SDK environment scope.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_VAR = 'GEMINI_CLI_SYSTEM_SETTINGS_PATH';

const configHarness = vi.hoisted(() => ({
  capturedEnvValues: [] as Array<string | undefined>,
  capturedSensitiveValues: [] as Array<Record<string, string | undefined>>,
}));

vi.mock('../src/utils/create-config.js', () => ({
  createGeminiConfig: vi.fn(() => {
    configHarness.capturedEnvValues.push(process.env[ENV_VAR]);
    configHarness.capturedSensitiveValues.push({
      GOOGLE_GEMINI_BASE_URL: process.env['GOOGLE_GEMINI_BASE_URL'],
      GEMINI_CLI_CUSTOM_HEADERS: process.env['GEMINI_CLI_CUSTOM_HEADERS'],
      GEMINI_API_KEY_AUTH_MECHANISM: process.env['GEMINI_API_KEY_AUTH_MECHANISM'],
      GOOGLE_GENAI_API_VERSION: process.env['GOOGLE_GENAI_API_VERSION'],
    });
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
    configHarness.capturedSensitiveValues.length = 0;
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

    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-config-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: { [ENV_VAR]: isolatedPath },
    });

    await connector.getModelMutationConfig();
    expect(configHarness.capturedEnvValues).toEqual([isolatedPath]);
    expect(process.env[ENV_VAR]).toBeUndefined();
  });

  it('does not set GEMINI_CLI_SYSTEM_SETTINGS_PATH in process.env when absent from connector env', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();

    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-no-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    await connector.getModelMutationConfig();
    expect(process.env[ENV_VAR]).toBeUndefined();
    expect(configHarness.capturedEnvValues).toEqual([undefined]);
  });

  it('restores a previous GEMINI_CLI_SYSTEM_SETTINGS_PATH after Config construction', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    process.env[ENV_VAR] = '/tmp/existing-gemini-settings.json';

    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-restore-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: { [ENV_VAR]: '/tmp/isolated-gemini-settings.json' },
    });

    await connector.getModelMutationConfig();
    expect(configHarness.capturedEnvValues).toEqual(['/tmp/isolated-gemini-settings.json']);
    expect(process.env[ENV_VAR]).toBe('/tmp/existing-gemini-settings.json');
  });

  it('clears a previous GEMINI_CLI_SYSTEM_SETTINGS_PATH during Config construction when connector env omits it', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    process.env[ENV_VAR] = '/tmp/existing-gemini-settings.json';

    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-clear-isolation',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    await connector.getModelMutationConfig();
    expect(configHarness.capturedEnvValues).toEqual([undefined]);
    expect(process.env[ENV_VAR]).toBe('/tmp/existing-gemini-settings.json');
  });

  it('keeps hostile Core transport and auth-mechanism inputs out of Config construction', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const hostile = {
      GOOGLE_GEMINI_BASE_URL: 'https://hostile.example',
      GEMINI_CLI_CUSTOM_HEADERS: 'Authorization: hostile',
      GEMINI_API_KEY_AUTH_MECHANISM: 'bearer',
      GOOGLE_GENAI_API_VERSION: 'v1alpha',
    };
    const previous = new Map(Object.keys(hostile).map((name) => [name, process.env[name]]));
    Object.assign(process.env, hostile);
    try {
      const connector = new GeminiConnector({
        bus,
        adapterId: 'adapter-test',
        adapterName: 'gemini-sdk',
        agentId: 'agent-hostile-core-env',
        model: 'gemini-2.5-flash',
        cwd: os.tmpdir(),
        env: {},
      });

      await connector.getModelMutationConfig();

      expect(configHarness.capturedSensitiveValues).toEqual([
        {
          GOOGLE_GEMINI_BASE_URL: undefined,
          GEMINI_CLI_CUSTOM_HEADERS: undefined,
          GEMINI_API_KEY_AUTH_MECHANISM: undefined,
          GOOGLE_GENAI_API_VERSION: undefined,
        },
      ]);
      expect(process.env).toMatchObject(hostile);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
