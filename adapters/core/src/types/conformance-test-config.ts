import type { BaseAgentConnectorConfig, AIAgentConnector } from '../agent/index.js';
import type { ScopedBus } from '@makaio/bus-core';
import type { AIAdapterInitOptions } from './ai-adapter-init-options.js';
import type { AIAdapter } from '../adapter/ai-adapter.js';
import type { AIAgent } from '../agent/ai-agent.js';
import type { ToolApprovalContext } from '../utils/tool-approval.js';
import type { AIReasoningLevel, ProviderContext } from '@makaio/contracts';

/**
 * Identifies a specific model offering for test execution.
 *
 * Resolves to a provider definition ID + model name, optionally with a default
 * reasoning effort level for tests that exercise reasoning.
 */
export interface TestModelRef {
  /** Provider definition ID to test against (e.g., 'anthropic', 'nanogpt'). */
  definitionId: string;
  /** Model identifier within the provider (e.g., 'haiku', 'gpt-4o-mini'). */
  modelName: string;
  /** Default reasoning effort for tests that exercise reasoning. */
  reasoningEffort?: AIReasoningLevel;
}

/**
 * Options for creating test agent instances.
 * Omits 'bus' (provided by test config) and makes 'adapterName'/'agentId' optional (factories provide defaults).
 */
export type CreateTestAgentOptions = Omit<BaseAgentConnectorConfig, 'bus' | 'adapterName' | 'model'> & {
  adapterName?: string;
  model?: string;
  /** Override the default test provider context when testing endpoint/credential behavior. */
  providerContext?: ProviderContext;
};

export interface ConformanceTestConfig<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  /**
   * Factory function for creating fresh agent instances.
   *
   * **Important**: Return a **new instance** on each call. The conformance
   * suite decides when to instantiate based on isolation requirements.
   *
   * **DO NOT** instantiate eagerly or return a singleton—tests may run
   * concurrently or require pristine state.
   * @returns Fresh connector instance configured for testing
   * @example
   * ```typescript
   * createConnector: () => new ClaudeCodeConnector({
   *   bus: testBus,
   *   agentId: `test-${Date.now()}`,
   *   sessionId: undefined, // Let adapter generate
   * })
   * ```
   */
  createConnector: (options?: CreateTestAgentOptions) => Promise<TConnector>;

  /**
   * Register a tool approval handler scoped to a specific connector.
   *
   * The handler will only receive approval requests from the given connector
   * (filtered by agentId). Returns an unsubscribe function for cleanup.
   * @param connector - The connector to scope approval handling to
   * @param context - Optional approval context (e.g., allowed tools, policies)
   * @returns Unsubscribe function to remove the handler
   */
  registerToolApprovalHandler(
    connector: TConnector,
    context: ToolApprovalContext | (() => Promise<ToolApprovalContext>),
  ): () => void;

  /**
   * Scoped bus instance for the adapter's namespace.
   *
   * This bus is used to emit events and handle requests in the adapter's
   * domain (e.g., 'claude-code', 'codex'). The conformance suite observes
   * events on this bus to verify behavior.
   *
   * **Namespace Isolation**: Each adapter should use a dedicated namespace
   * to prevent cross-talk between concurrent test suites.
   * @example
   * ```typescript
   * import { MakaioBus } from '@makaio/bus-core';
   *
   * const scopedBus = MakaioBus.scoped('claude-code');
   * ```
   */
  bus: ScopedBus<string>;

  /**
   * Optional capability flags indicating adapter-specific features.
   *
   * These flags allow conformance tests to:
   * - Skip tests for unsupported features (e.g., replace mode)
   * - Verify optional behaviors when supported
   * - Provide clear capability documentation
   *
   * **Default**: All capabilities are `false` (core features only)
   *
   * ## When to Enable
   *
   * - `supportsReplace`: Adapter implements 'replace' delivery mode
   * (clears pending queue before enqueuing message)
   * - `supportsInterrupt`: Adapter exposes `interrupt()` method
   * (cancels active turn mid-execution)
   * - `supportsUsageMetrics`: Adapter emits `agent.usage` events
   * (token counts, cost tracking)
   * @example Full Capabilities
   * ```typescript
   * capabilities: {
   *   supportsReplace: true,      // Claude Code's replace mode
   *   supportsInterrupt: true,     // Claude Code's interrupt()
   *   supportsUsageMetrics: true,  // Usage tracking
   * }
   * ```
   * @example Core Features Only
   * ```typescript
   * capabilities: undefined // or omit entirely
   * // Tests will skip replace, interrupt, tool approval, and usage tests
   * ```
   */
  capabilities?: {
    /**
     * Supports 'replace' message delivery mode.
     *
     * When enabled, the adapter clears the pending message queue before
     * enqueuing a new message. This is useful for "superseding" interactions.
     *
     * **Claude Code**: `true` (implements replace via MCP SDK)
     * **Basic Adapters**: `false` (enqueue/immediate only)
     */
    supportsReplace?: boolean;

    /**
     * Supports `interrupt()` method for cancelling active turns.
     *
     * When enabled, the adapter can abort mid-turn execution (e.g., during
     * a long-running tool call or reasoning phase).
     *
     * **Claude Code**: `true` (exposes interrupt via MCP SDK)
     * **Stateless Adapters**: `false` (no turn state to interrupt)
     */
    supportsInterrupt?: boolean;

    /**
     * Supports usage metrics via `agent.usage` events.
     *
     * When enabled, the adapter emits token counts and cost data after
     * turns or at session completion.
     *
     * **Claude Code**: `true` (exposes MCP usage data)
     * **Free-Tier Adapters**: `false` (no usage tracking)
     */
    supportsUsageMetrics?: boolean;
  };

  /**
   * Test configuration and environment options.
   *
   * These options tune test behavior without affecting adapter functionality.
   * All fields are optional with sensible defaults.
   * @example
   * ```typescript
   * options: {
   *   defaultTimeout: 30000,               // 30s for slow CI
   *   fastModel: 'claude-3-haiku-20240307', // Fast model for tests
   *   tmpDir: '/tmp/conformance-tests',    // Isolated temp directory
   * }
   * ```
   */
  options?: {
    /**
     * Default timeout for tests in milliseconds.
     *
     * Applies to async operations like agent.start() and message delivery.
     * Individual tests can override via Vitest's `{ timeout: ... }`.
     * @defaultValue 10000 (10 seconds)
     * @example
     * ```typescript
     * defaultTimeout: 30000 // 30s for slow CI environments
     * ```
     */
    defaultTimeout?: number;

    /**
     * Maximum concurrent test FILES for this adapter.
     *
     * Controls how many conformance test files run simultaneously when using
     * the programmatic test runner (scripts/test-adapters.ts). Each adapter
     * can specify its own concurrency based on rate limits or resource constraints.
     *
     * **How it works:**
     * - Test runner creates a per-adapter queue with this concurrency limit
     * - Test files for this adapter run through the queue
     * - Multiple adapters can run in parallel, each with its own queue
     *
     * **vs testConcurrency:**
     * - `concurrency`: Limits concurrent TEST FILES
     * - `testConcurrency`: Limits concurrent OPERATIONS within test helpers
     * @defaultValue 2 (when not specified)
     * @example
     * ```typescript
     * // Rate-limited API (e.g., Gemini free tier)
     * concurrency: 1  // Run test files sequentially
     *
     * // High-throughput API
     * concurrency: 4  // Run 4 test files in parallel
     * ```
     */
    concurrency?: number;

    /**
     * Cheap/fast model for cost-sensitive test execution.
     *
     * Used by most conformance tests that make real API calls.
     * Derived from the default provider preset's `fastModel` (or `defaultModel` as fallback).
     *
     * **Claude**: `{ definitionId: 'anthropic', modelName: 'haiku' }`
     * **Gemini**: `{ definitionId: 'gemini', modelName: 'gemini-2.5-flash' }`
     * @example
     * ```typescript
     * primaryModel: { definitionId: 'anthropic', modelName: 'haiku' }
     * ```
     */
    primaryModel?: TestModelRef;

    /**
     * Secondary model for model-switching tests.
     *
     * Used as the target model in model-change conformance tests.
     * Derived from the default provider preset's `defaultModel`.
     *
     * **Claude**: `{ definitionId: 'anthropic', modelName: 'sonnet' }`
     * **Gemini**: `{ definitionId: 'gemini', modelName: 'gemini-2.5-pro' }`
     * @example
     * ```typescript
     * secondaryModel: { definitionId: 'anthropic', modelName: 'sonnet' }
     * ```
     */
    secondaryModel?: TestModelRef;

    /**
     * Temporary directory for file operations during tests.
     *
     * Used for tests that create artifacts (logs, cached responses, etc.).
     * Should be isolated per test suite to prevent collisions.
     * @defaultValue OS temp dir + random suffix
     * @example
     * ```typescript
     * tmpDir: '/tmp/conformance-tests-claude-code'
     * ```
     */
    tmpDir?: string;

    /**
     * Maximum concurrent test operations for this adapter.
     *
     * When set, test infrastructure serializes context creation and key
     * operations through a per-adapter queue. Useful for adapters with
     * aggressive rate limits (e.g., Gemini free tier).
     *
     * **Default**: undefined (no throttling - tests run fully concurrent)
     * @example
     * ```typescript
     * testConcurrency: 1 // Serialize all test operations
     * ```
     */
    testConcurrency?: number;
  };

  /**
   * Factory function for creating full adapter instances (orchestration tests).
   *
   * **Orchestration vs Agent Tests:**
   * - Agent tests (`createAgent`): Direct agent instantiation, bypass session manager
   * - Orchestration tests (`createAdapter`): Full pipeline via MakaioBus.request()
   *
   * When provided, enables orchestration-level conformance tests that verify:
   * - Bus request/response flow (AdapterSubjects.sendMessage, etc.)
   * - Session manager lifecycle
   * - Event transformation pipeline (SDK to Adapter to Global)
   * - Multi-adapter coordination
   *
   * **Important**: Each call should return a fresh instance with unique adapterId
   * for test isolation. The factory receives optional init options to allow
   * passing a specific adapterId.
   * @returns Fresh AIAdapter instance configured for orchestration testing
   * @example
   * ```typescript
   * createAdapter: (options) => createClaudeAdapter({
   *   adapterId: options?.adapterId ?? `test-${crypto.randomUUID()}`,
   *   ...options
   * })
   * ```
   */
  createAdapter?: (options?: AIAdapterInitOptions) => Promise<AIAdapter<TBus, TConnector, TAgent>>;

  /**
   * Adapter type name for orchestration tests (e.g., 'claude-code').
   * Required when createAdapter is provided.
   */
  adapterName?: string;

  /**
   * Unresolved provider context for the test provider.
   *
   * Contains credential refs (e.g. `env:ANTHROPIC_API_KEY`) built from the test
   * provider definition's `credentialEnvVars`. Used by orchestration tests that
   * call `startAgent` directly (bypassing the conformance `createConnector` path
   * where `resolveTestConfig` handles credential ref building).
   *
   * The conformance test infrastructure registers a credential channel handler
   * that resolves `env:` refs from `process.env` so connectors can call
   * `resolveConnectorCredentials()` without a real credential store.
   */
  testProviderContext?: ProviderContext;

  /**
   * Optional cleanup hook for adapter-specific test infrastructure.
   *
   * Use this for resources created by `createTestConfig()` that outlive
   * individual connectors/adapters (for example shared test servers).
   */
  cleanup?: () => Promise<void> | void;
}
