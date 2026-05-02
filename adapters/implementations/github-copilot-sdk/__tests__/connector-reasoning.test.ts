/**
 * Tests for GitHub Copilot connector reasoning effort wiring.
 *
 * Tests cover:
 * - `toSdkReasoningEffort`: mapping from canonical AIReasoningLevel to SDK ReasoningEffort
 * - Constructor wiring: reasoningEffort in config flows through to SessionConfig
 * - `changeReasoningInPlace`: updates defaultSessionConfig and returns true
 * - 'none' level: reasoningEffort is omitted from SessionConfig
 *
 * Strategy: SessionConfig captured via the mocked SDK client's
 * `createSession(...)` input so the real connector session wrapper is covered.
 *
 * The Copilot SDK client is external and cannot be exercised in unit tests.
 * These tests verify the connector's reasoning mapping and lifecycle decisions
 * at the SDK boundary, which is the correct test seam for this adapter.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const capturedSessionConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// Mock session environment resolution so tests are not gated on a real credential
// channel. These tests verify connector reasoning wiring, not credential resolution.
vi.mock('@makaio/ai-adapters-core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/ai-adapters-core/config')>();
  return {
    ...actual,
    resolveSessionEnvironment: vi.fn().mockResolvedValue({
      credentials: { token: 'mock-copilot-token' },
      credEnv: { COPILOT_TOKEN: 'mock-copilot-token' },
      resolvedBinary: undefined,
      spawnEnv: { COPILOT_TOKEN: 'mock-copilot-token' },
    }),
  };
});

vi.mock('@github/copilot-sdk', () => {
  class MockCopilotClient {
    public constructor(_config: unknown) {}
    public async start(): Promise<void> {}
    public async stop(): Promise<void> {}
    public async createSession(config: unknown): Promise<{
      sessionId: string;
      on: (cb: () => void) => void;
      destroy: () => Promise<void>;
    }> {
      capturedSessionConfigs.push(config as Record<string, unknown>);
      return {
        sessionId: 'copilot-session-test',
        on: (_cb: () => void) => {},
        destroy: async () => {},
      };
    }
  }

  return { CopilotClient: MockCopilotClient };
});

import { GitHubCopilotConnector, toSdkReasoningEffort } from '../src/connector.js';
import { GitHubCopilotConnectorNamespace } from '../src/namespaces/index.js';
import type { AIReasoningLevel } from '@makaio/contracts';
import { CredentialRefSchema } from '@makaio/contracts/config';

// ---------------------------------------------------------------------------
// Pure mapping function
// ---------------------------------------------------------------------------

describe('toSdkReasoningEffort', () => {
  it.each([
    ['none', undefined],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['extra-high', 'xhigh'],
  ] satisfies [AIReasoningLevel, string | undefined][])('maps %s → %s', (level, expected) => {
    expect(toSdkReasoningEffort(level)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Constructor wiring
// ---------------------------------------------------------------------------

describe('github-copilot-sdk connector reasoning wiring', () => {
  beforeEach(() => {
    capturedSessionConfigs.length = 0;
  });

  /**
   * Build a minimal connector config for testing.
   * @param reasoningEffort - Optional canonical reasoning level
   * @returns Connector config object
   */
  async function makeConnector(reasoningEffort?: AIReasoningLevel) {
    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    return new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      reasoningEffort,
      providerContext: {
        providerConfigId: 'test-provider-config-id',
        definitionId: 'github-copilot',
        credentialRefs: { token: CredentialRefSchema.parse('env:COPILOT_TOKEN') },
        credentialEnvVars: { token: 'COPILOT_TOKEN' },
      },
    });
  }

  it('passes reasoningEffort through to SessionConfig when set', async () => {
    const connector = await makeConnector('high');
    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0].reasoningEffort).toBe('high');
  });

  it('maps extra-high to xhigh in SessionConfig', async () => {
    const connector = await makeConnector('extra-high');
    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0].reasoningEffort).toBe('xhigh');
  });

  it('omits reasoningEffort from SessionConfig when level is none', async () => {
    const connector = await makeConnector('none');
    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0]).not.toHaveProperty('reasoningEffort');
  });

  it('omits reasoningEffort from SessionConfig when not provided', async () => {
    const connector = await makeConnector();
    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0]).not.toHaveProperty('reasoningEffort');
  });

  // ---------------------------------------------------------------------------
  // changeReasoningInPlace
  // ---------------------------------------------------------------------------

  it('changeReasoningInPlace returns true and updates defaultSessionConfig when no session exists', async () => {
    const connector = await makeConnector('low');
    // Apply in-place change before session initialization — no live session yet
    const result = await connector.changeReasoningInPlace('medium');
    expect(result).toBe(true);

    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0].reasoningEffort).toBe('medium');
  });

  it('changeReasoningInPlace returns false when a live session already exists', async () => {
    const connector = await makeConnector('low');
    // Initialize session first so this.session is set
    await connector.initialize();
    capturedSessionConfigs.length = 0;

    // In-place change after session is live must return false so the
    // mutation manager falls back to a connector swap.
    const result = await connector.changeReasoningInPlace('high');
    expect(result).toBe(false);

    // defaultSessionConfig is still updated so the next session (after swap)
    // will be created with the correct effort.
    expect(capturedSessionConfigs).toHaveLength(0);
  });

  it('changeReasoningInPlace removes reasoningEffort when level is none', async () => {
    const connector = await makeConnector('high');
    await connector.changeReasoningInPlace('none');
    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0]).not.toHaveProperty('reasoningEffort');
  });

  it('changeReasoningInPlace does not mutate currentReasoningEffort (caller owns it)', async () => {
    const connector = await makeConnector('low');
    // currentReasoningEffort is set from config in base constructor
    expect(connector.currentReasoningEffort).toBe('low');

    await connector.changeReasoningInPlace('high');

    // Per mutation contract: implementor MUST NOT update currentReasoningEffort
    expect(connector.currentReasoningEffort).toBe('low');
  });

  // ---------------------------------------------------------------------------
  // Provider-level reasoningEffort does not leak through spread
  // ---------------------------------------------------------------------------

  it('does not leak providerConfig.reasoningEffort when canonical level maps to undefined (none)', async () => {
    // Simulate a providerConfig that carries a `reasoningEffort` field (e.g. a
    // stale or misconfigured provider payload). The canonical reasoningEffort
    // on the connector itself is 'none', which maps to undefined in the SDK,
    // so the field must be ABSENT from the SessionConfig regardless of the
    // provider-level value.
    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      reasoningEffort: 'none',
      providerContext: {
        providerConfigId: 'test-provider-config-id',
        definitionId: 'github-copilot',
        credentialRefs: { token: CredentialRefSchema.parse('env:COPILOT_TOKEN') },
        credentialEnvVars: { token: 'COPILOT_TOKEN' },
      },
      // Cast required: providerConfig type does not declare reasoningEffort,
      // but we want to verify the runtime guard handles unexpected fields.
      providerConfig: { reasoningEffort: 'high' } as never,
    });

    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    // The provider-level 'high' must not appear; canonical 'none' → omit entirely.
    expect(capturedSessionConfigs[0]).not.toHaveProperty('reasoningEffort');
  });

  it('strips connector-owned providerConfig fields from SessionConfig', async () => {
    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      providerContext: {
        providerConfigId: 'test-provider-config-id',
        definitionId: 'github-copilot',
        credentialRefs: { token: CredentialRefSchema.parse('env:COPILOT_TOKEN') },
        credentialEnvVars: { token: 'COPILOT_TOKEN' },
      },
      providerConfig: {
        sessionId: 'provider-session',
        model: 'provider-model',
        streaming: false,
        onPermissionRequest: 'not-a-handler',
        maxMessages: 25,
      } as never,
    });

    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0].sessionId).not.toBe('provider-session');
    expect(capturedSessionConfigs[0].model).toBe('gpt-4o-mini');
    expect(capturedSessionConfigs[0].streaming).toBe(true);
    expect(capturedSessionConfigs[0].onPermissionRequest).toBeTypeOf('function');
    expect(capturedSessionConfigs[0]).not.toHaveProperty('maxMessages');
  });
});
