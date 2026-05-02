/**
 * Ephemeral inference handler.
 *
 * Standalone function for `adapter.infer` — one-shot inference without agent
 * lifecycle. Creates an ephemeral connector, executes inference, extracts
 * text, and cleans up. Has no coupling to the agent registry.
 */
import type { ScopedBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../agent/index.js';
import type { ConfigFactoryInput } from './ai-adapter-config.js';
import type { BaseAgentConnectorConfig } from '../agent/types.js';
import type { PlatformDefaults } from '../types/ai-adapter-init-options.js';
import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import { AdapterSubjects, type ProviderContext } from '@makaio/contracts';
import { createSentinelProviderContext, normalizeMessageInput } from '../utils/index.js';

type InferRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.infer>;
type InferResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.infer>;

/**
 * Dependencies required by the ephemeral inference handler.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 */
export interface HandleInferDeps<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  /** Scoped bus for adapter-specific events. */
  adapterBus: TBus;
  /** Adapter instance identifier. */
  adapterId: string;
  /** Adapter type name. */
  adapterName: string;
  /** Platform-provided defaults (cwd, env). */
  platformDefaults: PlatformDefaults | undefined;
  /** Config factory — transforms partial input into full adapter-specific config. */
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Connector factory — creates connector from full config. */
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => TConnector | Promise<TConnector>;
}

/**
 * Handle adapter.infer — one-shot inference without agent lifecycle.
 *
 * Creates an ephemeral connector, executes inference, extracts text, and
 * cleans up. The ephemeral agent ID is never registered in the agent registry.
 * @param ctx - Request context with InferRequest payload
 * @param deps - Adapter-provided dependencies for connector creation
 */
export async function handleInfer<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  ctx: RequestContext<InferRequestPayload, InferResponsePayload>,
  deps: HandleInferDeps<TBus, TConnector>,
): Promise<void> {
  const { prompt, model, systemPrompt } = ctx.payload;

  // providerContext is optional to support health checks and local adapters that
  // omit provider setup. When absent, fall back to a sentinel so connectors can
  // still apply env-var or local-tooling credential resolution.
  //
  // Cast is safe: zod validated the incoming payload, so credentialRefs values
  // are genuine CredentialRef-branded strings. Zod loses the brand when inferring
  // through union schemas, so we restore it here with a single-step cast.
  const effectiveProviderContext = (ctx.payload.providerContext ?? createSentinelProviderContext()) as ProviderContext;

  // Generate ephemeral agentId for this inference call
  const ephemeralAgentId = crypto.randomUUID();

  // Build ConfigFactoryInput for the ephemeral connector
  const configInput: ConfigFactoryInput<TBus> = {
    bus: deps.adapterBus,
    agentId: ephemeralAgentId,
    adapterId: deps.adapterId,
    adapterName: deps.adapterName,
    providerContext: effectiveProviderContext,
    ...(model !== undefined && { model }),
    // Use platform defaults for cwd/env
    ...(deps.platformDefaults?.cwd !== undefined && { cwd: deps.platformDefaults.cwd }),
    ...(deps.platformDefaults?.env !== undefined && { env: deps.platformDefaults.env }),
    // No-op error handler for ephemeral connector
    errorHandler: (error: Error) => {
      console.warn(`[handleInfer:${deps.adapterName}] Ephemeral connector error: ${error.message}`);
    },
  };

  // Get full config from adapter's config factory
  const fullConfig = await deps.configFactory(configInput);

  // Create ephemeral connector
  const connector = await deps.connectorFactory(fullConfig);

  try {
    // Keep infer lifecycle aligned with normal agent flow: initialize before start.
    await connector.initialize({
      ...(systemPrompt !== undefined && { systemPrompt }),
    });

    // Execute inference
    const normalizedMessage = normalizeMessageInput(prompt);
    const startResult = await connector.start(normalizedMessage, {
      ...(systemPrompt !== undefined && { systemPrompt }),
    });

    // Wait for completion
    const result = await startResult.messageHandle.waitForCompletion();

    // Extract text from result
    const text = result.result?.message ?? '';

    // Note: usage tracking happens at the agent level through agent.usage events.
    // For ephemeral infer calls, we don't track usage (no persistent agent).
    ctx.setResult({ text });
  } finally {
    // Guard against cleanup errors masking the original error
    try {
      await connector.close();
    } catch (cleanupError) {
      console.warn(`[handleInfer:${deps.adapterName}] Connector cleanup error:`, cleanupError);
    }
  }
}
