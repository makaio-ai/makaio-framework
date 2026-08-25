import path from 'path';
import fs, { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  type AgentStartResult,
  AIAgentConnector,
  type ConformanceTestConfig,
  type CreateConformanceTestConfigOptions,
  type CreateTestAgentOptions,
  type TestModelRef,
  normalizeMessageInput,
  AIAdapter,
  createNoAuthTestProviderContext,
} from '@makaio/ai-adapters-core';
import { MakaioBus, createChannelEndpoint } from '@makaio/bus-core';
import {
  registerMemoryAgentStorage,
  registerMemorySessionStorage,
  MakaioSessionService,
} from '@makaio/services-core/session';
import os from 'node:os';
import { filesystemToolset } from '@makaio/extension-filesystem';
import { ToolRegistry } from '@makaio/services-core/tools';
import PQueue from 'p-queue';
import { afterAll, expect, type TaskMeta } from 'vitest';
import {
  type AgentComplete,
  type AIReasoningLevel,
  type ProviderContext,
  CredentialSubjects,
  McpSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
} from '@makaio/contracts';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { type EventContext } from '@makaio/core';
import { resolveCredentialRef } from '@makaio/ai-adapters-core/config';
import { startHttpMcpServer } from '@makaio/subsystem-mcp-http-server';
import { createMcpTestServerLifecycle } from './mcp-test-server-lifecycle.js';

// Module augmentation for vitest TaskMeta lives in scripts/lib/vitest-meta.d.ts.

// Register framework namespaces before any bus operation so that schema
// validation, local-subject routing, and extendSubject() are active in tests.
MakaioBus.registerNamespaces(FrameworkContractNamespaces);
MakaioBus.registerNamespaces(FrameworkStorageNamespaces);

const unsub = MakaioBus.__onAny((context) => {
  const payload = context.payload as {
    adapterId?: string;
    agentId?: string;
    sessionId?: string;
    adapterSessionId?: string;
    timestamp?: number;
  };

  const { adapterId, agentId, adapterSessionId, sessionId, timestamp, ...rest } = payload;
  if (context.payload) {
    const cleanedContext: Record<string, unknown> = {
      ...context,
      payload: rest,
    };

    const logMessage: Record<string, unknown> = {
      timestamp: timestamp ?? Date.now(),
      content: cleanedContext,
    };

    if (adapterId) logMessage['adapterId'] = adapterId;
    if (agentId) logMessage['agentId'] = agentId;
    if (adapterSessionId) logMessage['adapterSessionId'] = adapterSessionId;
    if (sessionId) logMessage['sessionId'] = sessionId;

    console.log(`[BUS] ${JSON.stringify(logMessage)}`);
  }
});

process.on('exit', () => {
  unsub();
});

const tmpPath = path.join(import.meta.dirname, '.tmp');
fs.mkdirSync(tmpPath, { recursive: true });

const logPath = path.join(import.meta.dirname, '.tmp/logs/');
fs.mkdirSync(logPath, { recursive: true });

/**
 * Minimal system prompt used by all conformance and orchestration tests.
 *
 * SDK default system prompts (Gemini, Copilot, etc.) condition the model as a
 * full CLI agent with tool instructions, guardrails, and memory features. This
 * inflates token usage and can trigger context overflow on multi-message tests.
 * Overriding with this minimal prompt keeps tests focused on protocol mechanics.
 */
export const CONFORMANCE_SYSTEM_PROMPT =
  'You are a helpful assistant. Keep responses very brief. Do not use any tools.';

/**
 * Minimal system prompt for tool-approval conformance tests.
 *
 * Same intent as CONFORMANCE_SYSTEM_PROMPT — replaces the large SDK default
 * prompt to prevent token bloat — but does NOT prohibit tool use, since
 * tool-approval tests require the model to attempt file operations.
 */
export const TOOL_APPROVAL_SYSTEM_PROMPT = 'You are a helpful assistant. Keep responses very brief.';

type ArrayMetaProps = 'adapterId' | 'agentId' | 'adapterSessionId' | 'sessionId';
type MetaArrays = Pick<TaskMeta, ArrayMetaProps>;

type MetaCarrier = {
  meta?: TaskMeta;
  task?: {
    meta?: TaskMeta;
  };
};

function resolveTaskMeta(context: object | undefined): TaskMeta | undefined {
  if (!context || typeof context !== 'object') {
    return undefined;
  }

  const candidate = context as MetaCarrier;
  return candidate.meta ?? candidate.task?.meta;
}

export function updateMeta(context: object | undefined, prop: ArrayMetaProps, value: string): void {
  const meta = resolveTaskMeta(context);
  if (meta) {
    const metaArrays = meta as MetaArrays;
    metaArrays[prop] ??= [];
    if (!metaArrays[prop]?.includes(value)) {
      metaArrays[prop]!.push(value);
    }
  }
}

export function updateMetaFromResponse(
  context: object | undefined,
  response:
    | { success: false }
    | {
        success: true;
        agentId?: string;
        adapterId?: string;
        adapterSessionId?: string;
        sessionId?: string;
        messageId?: string;
      },
) {
  if (response.success) {
    for (const [prop, value] of Object.entries(response)) {
      if (prop !== 'success' && typeof value === 'string') {
        updateMeta(context, prop as ArrayMetaProps, value);
      }
    }
  }
}

/**
 * Resolve a TestModelRef to startAgent-compatible params (model + providerContext).
 *
 * When a `testProviderContext` is supplied (from the adapter's `ConformanceTestConfig`),
 * it is used directly — providing credential refs and endpoint overrides for
 * orchestration tests that call `startAgent`. The conformance test infrastructure
 * registers a credential channel that resolves `env:` refs from `process.env`.
 * @param ref - TestModelRef to resolve (undefined = no params)
 * @param testProviderContext - Optional unresolved provider context with credential refs
 * @returns Object with model and providerContext, or empty object if ref is undefined
 */
export function resolveModelRef(
  ref?: TestModelRef,
  testProviderContext?: ProviderContext,
): { model: string; reasoningEffort?: AIReasoningLevel; providerContext: ProviderContext } | Record<string, never> {
  if (!ref) return {};
  return {
    model: ref.modelName,
    ...(ref.reasoningEffort !== undefined && { reasoningEffort: ref.reasoningEffort }),
    providerContext:
      testProviderContext ?? createNoAuthTestProviderContext('test-provider-config-id', ref.definitionId),
  };
}

/**
 * Assert that a complete event represents a successful turn.
 *
 * Checks the error field first so the actual error string appears in test output
 * when a rate limit or other LLM error causes the turn to fail. After calling
 * this helper, callers can access `completed.payload.message` without optional
 * chaining.
 * @param completed - The complete event context from bus observation
 */
export function assertCompletedTurn(
  completed: EventContext<AgentComplete> | null | undefined,
): asserts completed is EventContext<AgentComplete & { outcome: 'completed'; message: string }> {
  expect(completed).toBeDefined();
  expect(completed?.payload.error).toBeUndefined();
  expect(completed?.payload.outcome).toBe('completed');
  expect(completed?.payload.message).toEqual(expect.any(String));
}

/** Per-adapter test queues for rate-limited adapters. */
const adapterTestQueues = new Map<string, PQueue>();
/** Adapter-level cleanup hooks registered from ConformanceTestConfig.cleanup. */
const adapterTestCleanups = new Set<() => Promise<void> | void>();

/**
 * Register adapter-specific cleanup for global test teardown.
 * @param testConfig - Conformance test config that may expose a cleanup hook
 */
function registerAdapterTestCleanup(testConfig: ConformanceTestConfig): void {
  if (testConfig.cleanup) {
    adapterTestCleanups.add(testConfig.cleanup);
  }
}

afterAll(async () => {
  try {
    for (const cleanup of adapterTestCleanups) {
      try {
        await cleanup();
      } catch (error) {
        console.warn('[Conformance tests] Adapter cleanup failed:', error);
      }
    }
  } finally {
    await testMcpServer.close();
    adapterTestCleanups.clear();
  }
});

/**
 * Get or create a test queue for an adapter.
 * Only creates a queue if testConcurrency is explicitly set.
 * @param adapterName - Adapter name to get/create queue for
 * @param concurrency - Max concurrent operations (undefined = no queue)
 */
function getAdapterTestQueue(adapterName: string, concurrency?: number): PQueue | undefined {
  if (concurrency === undefined) return undefined;

  if (!adapterTestQueues.has(adapterName)) {
    adapterTestQueues.set(adapterName, new PQueue({ concurrency, interval: 5_000, intervalCap: 3 }));
  }
  return adapterTestQueues.get(adapterName);
}

// Initialize ToolRegistry for tests - registers handlers for ToolSubjects.list and ToolSubjects.execute
const testToolRegistry = new ToolRegistry();
await testToolRegistry.register(filesystemToolset);

// Register memory storage handlers before session service (required by MakaioSessionService contract).
// Agent storage must be present too: runtime mutations (cwd/model change) report
// `*_committed_persistence_failed` when `storage:agent.updateRuntime` goes unhandled.
registerMemorySessionStorage(MakaioBus);
registerMemoryAgentStorage(MakaioBus);

// Register a credential channel so connectors can call resolveConnectorCredentials() in tests.
// The subscription is intentionally never unsubscribed — it's global test harness infrastructure
// shared across all conformance suites. The endpoint close is synchronous, so `exit` cleanup is
// sufficient here.
// The channel resolves `env:VAR_NAME` refs from process.env (populated from test provider definitions).
// Keeps credentials out of the bus — same security contract as production.
const testCredentialToken = `test-credential-token-${crypto.randomUUID()}`;
MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
  ctx.setResult({ token: testCredentialToken });
});
const testCredentialEndpoint = createChannelEndpoint(
  MakaioBus.getContext(),
  'credentials',
  (channel) => {
    channel.on(CredentialSubjects.resolve, async (ctx) => {
      const ref = CredentialRefSchema.parse(ctx.payload.ref);
      const value = await resolveCredentialRef(ref);
      ctx.setResult({ value });
    });
  },
  { token: testCredentialToken },
);
process.on('exit', () => {
  testCredentialEndpoint.close();
});

// Shared MCP server for subprocess-based adapters (claude-code-cli, claude-agent-sdk).
// The lifecycle stays worker-scoped, but startup failures must be retryable and
// the async `close()` must run from `afterAll`, not `process.on('exit')`.
const testMcpServer = createMcpTestServerLifecycle(() => startHttpMcpServer(MakaioBus));

MakaioBus.on(McpSubjects.session.register, async (ctx) => {
  const { adapterSessionId, agentId, adapterId, adapterName, sessionId } = ctx.payload;
  const handle = await testMcpServer.ensureStarted();
  handle.contextRegistry.register(adapterSessionId, {
    agentId,
    adapterId,
    adapterName,
    adapterSessionId,
    sessionId,
  });
  ctx.setResult({ port: handle.port });
});

MakaioBus.on(McpSubjects.session.unregister, (ctx) => {
  testMcpServer.getHandle()?.contextRegistry.unregister(ctx.payload.adapterSessionId);
  ctx.setResult({});
});

const _sessionService = new MakaioSessionService();
await _sessionService.init();

export const adaptersPath = path.join(import.meta.dirname, '../');

export type AgentTestContext = {
  adapterImport: ImportedAdapter;
  testConfig: Omit<ConformanceTestConfig, 'createConnector'>;
  agent: AIAgentConnector;
  getAgentStartResult: () => Promise<AgentStartResult>;
  createConnector: (options?: Partial<CreateTestAgentOptions>) => Promise<AIAgentConnector>;
  agentId: string;
  adapterId: string;
  conformanceSystemPrompt: string;
};

export type OrchestrationTestContext = {
  adapter: AIAdapter;
  adapterId: string;
  adapterName: string;
  testConfig: Omit<ConformanceTestConfig, 'createConnector'>;
};

export type ImportedAdapter = {
  createTestConfig: (options?: CreateConformanceTestConfigOptions) => Promise<ConformanceTestConfig>;
};
/**
 * Get the single adapter under test from MAKAIO_TEST_ADAPTER env var.
 * Throws if not set - each vitest project should set this.
 */
export const getAdapterUnderTest = (): string => {
  const adapter = process.env.MAKAIO_TEST_ADAPTER;
  if (!adapter) {
    const adapterDirs = readdirSync(adaptersPath, { withFileTypes: true })
      .filter(
        (dirent) =>
          dirent.isDirectory() &&
          !dirent.name.includes('__') &&
          !dirent.name.startsWith('.') &&
          !dirent.name.includes('node_modules'),
      )
      .map((dirent) => dirent.name);
    throw new Error(
      'MAKAIO_TEST_ADAPTER environment variable must be set. ' +
        'Run tests via vitest projects or set MAKAIO_TEST_ADAPTER manually.' +
        `Possible values: ${adapterDirs.join(', ')}`,
    );
  }
  return adapter;
};

export const importAdapter = async (adapterName: string): Promise<ImportedAdapter> => {
  const adapterTestEntrypoint = path.join(adaptersPath, adapterName, 'src/test/index.ts');
  const adapterPath = fs.existsSync(adapterTestEntrypoint)
    ? path.join(adaptersPath, adapterName, 'src/test/index.js')
    : path.join(adaptersPath, adapterName, 'src/index.js');
  return import(pathToFileURL(adapterPath).href) as Promise<ImportedAdapter>;
};

/**
 * Get agent-level conformance test context for an adapter.
 * @param adapterName - Name of adapter to test
 * @param cacheStartResult - Whether to cache the initial start result across tests
 * @param initialMessage - Initial prompt sent when starting the connector
 * @param createTestConfigOptions - Optional provider definitions supplied by the conformance harness
 * @returns Agent test context with connector helpers
 */
export const getAgentTestContext = async (
  adapterName: string,
  cacheStartResult = false,
  initialMessage = 'Reply with the single word: OK',
  createTestConfigOptions?: CreateConformanceTestConfigOptions,
): Promise<AgentTestContext> => {
  const awaitedStartResults = new Map<string, Promise<AgentStartResult>>();

  const adapterImport = await importAdapter(adapterName);
  const testConfig = await adapterImport.createTestConfig(createTestConfigOptions);
  registerAdapterTestCleanup(testConfig);

  // Get queue if adapter has testConcurrency set
  const queue = getAdapterTestQueue(adapterName, testConfig.options?.testConcurrency);
  const agentId = crypto.randomUUID();
  const agent = await testConfig.createConnector({
    cwd: os.tmpdir(),
    reasoningEffort: testConfig.options?.primaryModel?.reasoningEffort ?? 'low',
    agentId,
    model: testConfig.options?.primaryModel?.modelName,
  });

  testConfig.registerToolApprovalHandler(
    agent,
    async () => ({
      adapterId: agent.adapterId,
      adapterName: agent.getAdapterName(),
      agentId: agent.getAgentId(),
      adapterSessionId: await agent.getAdapterSessionId(),
      sessionId: 'conformance-test-session',
    }),
    MakaioBus,
  );

  const conformanceSystemPrompt = CONFORMANCE_SYSTEM_PROMPT;

  const getAgentStartResultCore = async () => {
    if (cacheStartResult) {
      // Use cache - share start result across tests
      if (!awaitedStartResults.has(adapterName)) {
        awaitedStartResults.set(
          adapterName,
          agent.start(normalizeMessageInput(initialMessage), {
            messageId: '11111111-1111-1111-1111-111111111111',
            systemPrompt: conformanceSystemPrompt,
          }),
        );
      }
      return awaitedStartResults.get(adapterName) as Promise<AgentStartResult>;
    } else {
      // No cache - fresh start every time
      return agent.start(normalizeMessageInput(initialMessage), {
        systemPrompt: conformanceSystemPrompt,
      });
    }
  };

  const primaryModel = testConfig.options?.primaryModel;

  const createConnectorCore = async (options?: Partial<CreateTestAgentOptions>) => {
    const connector = await testConfig.createConnector({
      cwd: os.tmpdir(),
      reasoningEffort: primaryModel?.reasoningEffort ?? 'low',
      agentId: crypto.randomUUID(),
      ...options,
      model: options?.model ?? primaryModel?.modelName,
    });
    testConfig.registerToolApprovalHandler(
      connector,
      async () => ({
        adapterId: connector.adapterId,
        adapterName: connector.getAdapterName(),
        agentId: connector.getAgentId(),
        adapterSessionId: await connector.getAdapterSessionId(),
        sessionId: 'conformance-test-session',
      }),
      MakaioBus,
    );
    return connector;
  };

  // Wrap in queue if testConcurrency is set
  const getAgentStartResult = queue
    ? () => queue.add(getAgentStartResultCore) as Promise<AgentStartResult>
    : getAgentStartResultCore;

  const createConnector = queue
    ? (options?: Partial<CreateTestAgentOptions>) =>
        queue.add(() => createConnectorCore(options)) as Promise<AIAgentConnector>
    : createConnectorCore;

  return {
    adapterImport,
    testConfig,
    agent,
    getAgentStartResult,
    createConnector,
    agentId,
    adapterId: agent.adapterId,
    conformanceSystemPrompt,
  };
};

/**
 * Get orchestration test context for adapter.
 *
 * Creates a full adapter instance (not just agent) for testing the complete
 * orchestration pipeline via MakaioBus.request().
 * @param adapterName - Name of adapter to test (e.g., 'claude-code')
 * @param adapterId - Optional adapter ID (generates unique ID if not provided)
 * @param createTestConfigOptions - Optional provider definitions supplied by the conformance harness
 * @returns Orchestration test context with adapter instance and metadata
 */
export const getOrchestrationTestContext = async (
  adapterName: string,
  adapterId?: string,
  createTestConfigOptions?: CreateConformanceTestConfigOptions,
): Promise<OrchestrationTestContext> => {
  const adapterImport = await importAdapter(adapterName);
  const testConfig = await adapterImport.createTestConfig(createTestConfigOptions);
  registerAdapterTestCleanup(testConfig);

  if (!testConfig.createAdapter) {
    throw new Error(`Adapter ${adapterName} doesn't support orchestration tests (missing createAdapter)`);
  }

  // Get queue if adapter has testConcurrency set
  const queue = getAdapterTestQueue(adapterName, testConfig.options?.testConcurrency);

  // Generate unique adapter ID for test isolation
  const finalAdapterId = adapterId ?? `test-${adapterName}-${crypto.randomUUID()}`;

  const createAdapterFn = () =>
    testConfig.createAdapter!({
      adapterId: finalAdapterId,
      machineId: 'test-machine',
      ownerInstanceId: 'test-owner-instance',
    });
  const adapter = queue ? await queue.add(createAdapterFn) : await createAdapterFn();

  return {
    adapter: adapter!,
    adapterId: adapter!.adapterId,
    adapterName: testConfig.adapterName ?? adapterName,
    testConfig,
  };
};
