/**
 * Ephemeral inference handler.
 *
 * Standalone function for `adapter.infer` — one-shot inference without agent
 * lifecycle. Creates an ephemeral connector, executes inference, extracts
 * text, and cleans up. Has no coupling to the agent registry.
 */
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../agent/index.js';
import type { ConfigFactoryInput } from './ai-adapter-config.js';
import type {
  AgentStartResult,
  BaseAgentConnectorConfig,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
} from '../agent/types.js';
import type { PlatformDefaults } from '../types/ai-adapter-init-options.js';
import type { ExtractSubjectPayload, ExtractSubjectResponse, RequestContext } from '@makaio/core';
import {
  AdapterSubjects,
  type ProviderContext,
  type ResponseSchemaDescriptor,
  type StructuredOutputValidationError,
} from '@makaio/contracts';
import { createSentinelProviderContext, normalizeMessageInput } from '../utils/index.js';
import { AgentStructuredOutputManager } from '../agent/agent-structured-output-manager.js';
import { buildStructuredOutputTurnContext } from '../agent/structured-output-turn-context.js';

type InferRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.infer>;
type InferResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.infer>;

interface ValidateInferOutputInput<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  connector: TConnector;
  manager: AgentStructuredOutputManager;
  responseSchema: ResponseSchemaDescriptor;
  startResult: AgentStartResult;
  text: string;
}

/**
 * Dependencies required by the ephemeral inference handler.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 */
export interface HandleInferDeps<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  /** Scoped bus for adapter-specific events. */
  adapterBus: TBus;
  /** Global bus used for structured-output retry and enforcement RPCs. */
  globalBus: IMakaioBus;
  /** Adapter instance identifier. */
  adapterId: string;
  /** Adapter type name. */
  adapterName: string;
  /** Capability tags reported by the adapter. */
  adapterCapabilities: string[];
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
  const { prompt, model, systemPrompt, responseSchema } = ctx.payload;

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
  const structuredOutputManager = new AgentStructuredOutputManager({
    bus: deps.globalBus,
    agentId: ephemeralAgentId,
    adapterId: deps.adapterId,
    adapterCapabilities: deps.adapterCapabilities,
  });

  // Build ConfigFactoryInput for the ephemeral connector
  const configInput: ConfigFactoryInput<TBus> = {
    bus: deps.adapterBus,
    globalBus: deps.globalBus,
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
      ...(responseSchema !== undefined && { responseSchema }),
    });

    // Execute inference
    const normalizedMessage = normalizeMessageInput(prompt);
    const startOptions: ConnectorStartOptions = {
      ...(systemPrompt !== undefined && { systemPrompt }),
      turnContext: buildStructuredOutputTurnContext(undefined, responseSchema, deps.adapterCapabilities),
      ...(responseSchema !== undefined && { responseSchema }),
    };
    const startResult = await connector.start(normalizedMessage, startOptions);

    // Wait for completion
    const result = await startResult.messageHandle.waitForCompletion();

    // Extract text from result
    let text = result.result?.message ?? '';

    if (responseSchema !== undefined && result.outcome === 'completed') {
      text = await validateInferStructuredOutput({
        connector,
        manager: structuredOutputManager,
        responseSchema,
        startResult,
        text,
      });
    }

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

/**
 * Validate completed infer output through the shared structured-output manager.
 * @param input - Connector, response schema, and raw infer completion data
 * @returns Conformant output text after validation, retry, or enforcement
 */
async function validateInferStructuredOutput<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  input: ValidateInferOutputInput<TBus, TConnector>,
): Promise<string> {
  const { connector, manager, responseSchema, startResult, text } = input;
  const validated = await manager.validateTerminalResult({
    responseSchema,
    message: text,
    retryTurn: async ({ attemptNumber, validationErrors }) => {
      const retryOptions: ConnectorSendMessageOptions = {
        deliveryMode: 'enqueue',
        internalRetry: true,
        messageId: `${startResult.messageHandle.messageId}:structured-output-retry:${attemptNumber}`,
        responseSchema,
        turnContext: {
          ...startResult.messageHandle.turnContext,
          structuredOutputRetry: {
            attemptNumber,
            validationErrors,
            instruction: 'Previous output did not match the requested JSON schema. Respond only with corrected JSON.',
          },
        },
      };
      const retryHandle = await connector.sendMessage(startResult.messageHandle.message, retryOptions);
      const retryResult = await retryHandle.waitForCompletion();
      return retryResult.result?.message ?? '';
    },
  });
  if (validated.structuredOutputValidation.status === 'failed') {
    throw createStructuredOutputValidationError(validated.structuredOutputValidation.errors);
  }
  return validated.message ?? '';
}

/**
 * Create the RPC failure surfaced when schema-constrained infer cannot be corrected.
 * @param errors - Normalized structured-output validation errors
 * @returns Error describing the failed schema validation
 */
function createStructuredOutputValidationError(errors: readonly StructuredOutputValidationError[]): Error {
  return new Error(`Structured output validation failed: ${errors.map((error) => error.message).join('; ')}`);
}
