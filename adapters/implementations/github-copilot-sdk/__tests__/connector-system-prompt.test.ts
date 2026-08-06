import { describe, expect, it, vi, beforeEach } from 'vitest';

const capturedSessionConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const capturedClientConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const lifecycleControls = vi.hoisted(() => ({
  blockInitialize: false,
  clientStopCalls: 0,
  clientStopError: undefined as Error | undefined,
  resolveInitialize: undefined as (() => void) | undefined,
  sessionDestroyCalls: 0,
  sessionDestroyError: undefined as Error | undefined,
}));

vi.mock('@github/copilot-sdk', () => {
  class MockCopilotClient {
    public constructor(config: Record<string, unknown>) {
      capturedClientConfigs.push(config);
    }
    public async start(): Promise<void> {}
    public async stop(): Promise<void> {
      lifecycleControls.clientStopCalls += 1;
      if (lifecycleControls.clientStopError) throw lifecycleControls.clientStopError;
    }
    public async createSession(_config: unknown): Promise<{ sessionId: string; on: (cb: () => void) => void }> {
      return {
        sessionId: 'copilot-session-test',
        on: (_cb: () => void) => {},
      };
    }
  }

  return { CopilotClient: MockCopilotClient };
});

vi.mock('../src/session.js', () => {
  class MockCopilotConnectorSession {
    public constructor(config: { sessionConfig: Record<string, unknown> }) {
      capturedSessionConfigs.push(config.sessionConfig);
    }
    public async initialize(): Promise<void> {
      if (!lifecycleControls.blockInitialize) return;
      await new Promise<void>((resolve) => {
        lifecycleControls.resolveInitialize = resolve;
      });
    }
    public async getAdapterSessionId(): Promise<string> {
      return 'adapter-session-test';
    }
    public async processQueue(): Promise<void> {}
    public async abort(): Promise<void> {}
    public beginClose(): void {}
    public async destroy(): Promise<void> {
      lifecycleControls.sessionDestroyCalls += 1;
      if (lifecycleControls.sessionDestroyError) throw lifecycleControls.sessionDestroyError;
    }
  }

  return { CopilotConnectorSession: MockCopilotConnectorSession };
});

import { GitHubCopilotConnector } from '../src/connector.js';
import { GitHubCopilotConnectorNamespace } from '../src/namespaces/index.js';

const testAdapterAuth = {
  processEnv: {},
  connectorDeliveries: [{ target: 'github-copilot-sdk.constructor', values: { githubToken: 'mock-copilot-token' } }],
  configInheritance: 'empty' as const,
};

describe('github-copilot-sdk connector system prompt handling', () => {
  beforeEach(() => {
    capturedSessionConfigs.length = 0;
    capturedClientConfigs.length = 0;
    lifecycleControls.blockInitialize = false;
    lifecycleControls.clientStopCalls = 0;
    lifecycleControls.clientStopError = undefined;
    lifecycleControls.resolveInitialize = undefined;
    lifecycleControls.sessionDestroyCalls = 0;
    lifecycleControls.sessionDestroyError = undefined;
    delete process.env['COPILOT_TOKEN'];
  });

  it('preserves provider systemMessage when runtime prompt is not set', async () => {
    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const providerSystemMessage = { mode: 'append', content: 'provider prompt' };
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      adapterAuth: testAdapterAuth,
      providerConfig: {
        systemMessage: providerSystemMessage,
      } as never,
    });

    await connector.initialize();

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0].systemMessage).toEqual(providerSystemMessage);
  });

  it('treats empty-string runtime prompt as an explicit replacement prompt', async () => {
    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      adapterAuth: testAdapterAuth,
    });

    await connector.initialize({ systemPrompt: '' });

    expect(capturedSessionConfigs).toHaveLength(1);
    expect(capturedSessionConfigs[0].systemMessage).toEqual({
      mode: 'replace',
      content: '',
    });
  });

  it('passes the resolved token to CopilotClient without mutating COPILOT_TOKEN', async () => {
    process.env['COPILOT_TOKEN'] = 'previous-token';

    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      adapterAuth: testAdapterAuth,
    });

    await connector.initialize();
    expect(capturedClientConfigs).toHaveLength(1);
    expect(capturedClientConfigs[0].githubToken).toBe('mock-copilot-token');
    expect(process.env['COPILOT_TOKEN']).toBe('previous-token');

    await connector.close();
    expect(process.env['COPILOT_TOKEN']).toBe('previous-token');
  });

  it('does not publish a session when close races in-flight initialization', async () => {
    lifecycleControls.blockInitialize = true;

    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      adapterAuth: testAdapterAuth,
    });

    const initializePromise = connector.initialize();
    await vi.waitFor(() => expect(lifecycleControls.resolveInitialize).toBeTypeOf('function'));

    const closePromise = connector.close();
    lifecycleControls.resolveInitialize?.();

    await expect(initializePromise).rejects.toThrow('GitHub Copilot session initialization was cancelled');
    await expect(closePromise).resolves.toMatchObject({ evidence: 'detached' });
    expect(lifecycleControls.sessionDestroyCalls).toBe(1);
    expect(lifecycleControls.clientStopCalls).toBe(1);

    lifecycleControls.blockInitialize = false;
    await expect(connector.initialize()).rejects.toThrow('GitHub Copilot connector is closed');
    expect(capturedSessionConfigs).toHaveLength(1);
  });

  it('does not report in-place reasoning changes as applied during in-flight initialization', async () => {
    lifecycleControls.blockInitialize = true;

    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    const connector = new GitHubCopilotConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      adapterAuth: testAdapterAuth,
    });

    const initializePromise = connector.initialize();
    await vi.waitFor(() => expect(lifecycleControls.resolveInitialize).toBeTypeOf('function'));

    await expect(connector.changeReasoningInPlace('high')).resolves.toBe(false);

    const closePromise = connector.close();
    lifecycleControls.resolveInitialize?.();
    await expect(initializePromise).rejects.toThrow('GitHub Copilot session initialization was cancelled');
    await closePromise;
  });

  it.each([
    ['provisional session destroy', () => (lifecycleControls.sessionDestroyError = new Error('destroy failed'))],
    ['provisional client stop', () => (lifecycleControls.clientStopError = new Error('stop failed'))],
  ])('reports unknown when %s fails during cancellation cleanup', async (stage, failCleanup) => {
    lifecycleControls.blockInitialize = true;
    failCleanup();

    const connector = new GitHubCopilotConnector({
      bus: await GitHubCopilotConnectorNamespace.scopedBus(),
      adapterId: 'adapter-test',
      adapterName: 'github-copilot-sdk',
      agentId: 'agent-test',
      model: 'gpt-4o-mini',
      cwd: process.cwd(),
      env: {},
      adapterAuth: testAdapterAuth,
    });

    const initializePromise = connector.initialize();
    await vi.waitFor(() => expect(lifecycleControls.resolveInitialize).toBeTypeOf('function'));

    const closePromise = connector.close();
    lifecycleControls.resolveInitialize?.();

    await expect(initializePromise).rejects.toThrow('GitHub Copilot session initialization cleanup failed');
    await expect(closePromise).resolves.toMatchObject({ evidence: 'unknown', detail: expect.stringContaining(stage) });
  });
});
