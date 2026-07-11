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
  ProviderContextSchema,
  type AdapterProviderAuth,
  type ProtocolId,
  type ProviderContext,
  type ResponseSchemaDescriptor,
  type StructuredOutputValidationError,
} from '@makaio/contracts';
import { createUnresolvedProviderContext, normalizeMessageInput } from '../utils/index.js';
import { AgentStructuredOutputManager } from '../agent/agent-structured-output-manager.js';
import { buildStructuredOutputTurnContext } from '../agent/structured-output-turn-context.js';
import type { AdapterProviderDefinition } from '../types/provider-definition.js';
import { resolveAdapterProviderSelection } from './ai-adapter-create-utils.js';
import {
  closeConnectorRuntime,
  createConnectorRuntime,
  type ConnectorRuntimeHandle,
} from '../agent/connector-runtime.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';
import {
  commitAdapterProviderContextActivation,
  prepareAdapterProviderContextActivation,
  rollbackAdapterProviderContextActivationAfterFailure,
} from './provider-context-activation-lifecycle.js';

type InferRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.infer>;
type InferResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.infer>;

interface ValidateInferOutputInput<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  connector: TConnector;
  manager: AgentStructuredOutputManager;
  responseSchema: ResponseSchemaDescriptor;
  startResult: AgentStartResult;
  text: string;
}

interface InferProviderSelection {
  readonly providerContext: ProviderContext;
  readonly providerProtocol?: ProtocolId;
  readonly adapterProviderAuth?: AdapterProviderAuth;
  readonly compatibleProviderAuths: readonly AdapterProviderAuth[];
}

interface ExecuteInferInput<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  readonly connector: TConnector;
  readonly manager: AgentStructuredOutputManager;
  readonly prompt: InferRequestPayload['prompt'];
  readonly systemPrompt?: string;
  readonly responseSchema?: ResponseSchemaDescriptor;
  readonly adapterCapabilities: readonly string[];
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
  /** Managed client identity, when the adapter is client-backed. */
  clientId?: string;
  /** Capability tags reported by the adapter. */
  adapterCapabilities: string[];
  /** Resolved provider definitions registered on the adapter. */
  definitionProviders: readonly AdapterProviderDefinition[];
  /** Platform-provided defaults (cwd, env). */
  platformDefaults: PlatformDefaults | undefined;
  /** Config factory — transforms partial input into full adapter-specific config. */
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Connector factory — creates connector from full config. */
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => TConnector | Promise<TConnector>;
  /** Trusted host-local auth preparer for the ephemeral connector. */
  prepareAuthRuntime?: AdapterAuthRuntimePreparer<TBus>;
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
  const selection = resolveInferProviderSelection(ctx.payload.providerContext, deps.definitionProviders);
  const ephemeralAgentId = crypto.randomUUID();
  const structuredOutputManager = new AgentStructuredOutputManager({
    bus: deps.globalBus,
    agentId: ephemeralAgentId,
    adapterId: deps.adapterId,
    adapterCapabilities: deps.adapterCapabilities,
  });
  const configInput: ConfigFactoryInput<TBus> = {
    bus: deps.adapterBus,
    globalBus: deps.globalBus,
    agentId: ephemeralAgentId,
    adapterId: deps.adapterId,
    adapterName: deps.adapterName,
    providerContext: selection.providerContext,
    ...(selection.providerProtocol !== undefined && { providerProtocol: selection.providerProtocol }),
    ...(selection.adapterProviderAuth !== undefined && { adapterProviderAuth: selection.adapterProviderAuth }),
    compatibleProviderAuths: selection.compatibleProviderAuths,
    providerContextRequired: deps.definitionProviders.length > 0,
    ...(deps.clientId !== undefined && { clientId: deps.clientId }),
    // Infer connectors are one-shot by design: never registered, never
    // resumable, closed immediately. Declare that so connectors skip
    // session persistence (no orphaned provider transcripts).
    ephemeral: true,
    ...(model !== undefined && { model }),
    // Use platform defaults for cwd/env
    ...(deps.platformDefaults?.cwd !== undefined && { cwd: deps.platformDefaults.cwd }),
    ...(deps.platformDefaults?.env !== undefined && { env: deps.platformDefaults.env }),
    errorHandler: () => {
      console.warn(`[handleInfer:${deps.adapterName}] Ephemeral connector failed.`);
    },
  };
  const connectorRuntime = await createReadyInferenceRuntime(deps, configInput, selection.providerContext, {
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(responseSchema !== undefined && { responseSchema }),
  });
  const execution = executeInitializedInference({
    connector: connectorRuntime.connector,
    manager: structuredOutputManager,
    prompt,
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(responseSchema !== undefined && { responseSchema }),
    adapterCapabilities: deps.adapterCapabilities,
  });
  const text = await completeInferenceRuntime(execution, connectorRuntime, deps.adapterName);
  ctx.setResult({ text });
}

/**
 * Prepare account state, materialize auth, and initialize one infer connector.
 * @param deps - Adapter factories and global activation bus
 * @param configInput - Refs-only connector configuration input
 * @param providerContext - Canonical provider selection for activation
 * @param options - Optional connector initialization inputs
 * @returns Ready connector runtime after activation commit
 */
async function createReadyInferenceRuntime<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  deps: HandleInferDeps<TBus, TConnector>,
  configInput: ConfigFactoryInput<TBus>,
  providerContext: ProviderContext,
  options: { readonly systemPrompt?: string; readonly responseSchema?: ResponseSchemaDescriptor },
): Promise<ConnectorRuntimeHandle<TConnector>> {
  const activation = await prepareAdapterProviderContextActivation(deps.globalBus, providerContext);
  let runtime: ConnectorRuntimeHandle<TConnector> | undefined;
  try {
    const fullConfig = await deps.configFactory(configInput);
    runtime = await createConnectorRuntime({
      config: fullConfig,
      connectorFactory: deps.connectorFactory,
      prepareAuthRuntime: deps.prepareAuthRuntime,
    });
    await runtime.connector.initialize(options);
    await commitAdapterProviderContextActivation(activation);
    return runtime;
  } catch (error) {
    const failedRuntime = runtime;
    return await rollbackAdapterProviderContextActivationAfterFailure({
      activation,
      primaryError: error,
      ...(failedRuntime !== undefined && { cleanup: () => closeConnectorRuntime(failedRuntime) }),
      operation: `Ephemeral inference for ${deps.adapterName}`,
      cleanupFailureMessage: `Ephemeral inference setup and connector cleanup both failed for ${deps.adapterName}.`,
    });
  }
}

/**
 * Resolve and canonically validate the provider selection at the bus boundary.
 * @param rawProviderContext - Untrusted provider context carried by the infer payload
 * @param definitions - Adapter/provider declarations available to the adapter
 * @returns Canonical provider context and its selected adapter auth metadata
 */
function resolveInferProviderSelection(
  rawProviderContext: InferRequestPayload['providerContext'],
  definitions: readonly AdapterProviderDefinition[],
): InferProviderSelection {
  const providerContext =
    rawProviderContext === undefined
      ? createUnresolvedProviderContext()
      : ProviderContextSchema.parse(rawProviderContext);
  if (providerContext.state === 'unresolved') {
    return { providerContext, compatibleProviderAuths: [] };
  }
  const selection = resolveAdapterProviderSelection(definitions, providerContext);
  return {
    providerContext,
    ...selection,
  };
}

/**
 * Execute one inference turn against an already-initialized ephemeral connector.
 * @param input - Connector, prompt, and optional structured-output contract
 * @returns Final inference text
 */
async function executeInitializedInference<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  input: ExecuteInferInput<TBus, TConnector>,
): Promise<string> {
  const { connector, manager, prompt, systemPrompt, responseSchema, adapterCapabilities } = input;
  const normalizedMessage = normalizeMessageInput(prompt);
  const startOptions: ConnectorStartOptions = {
    ...(systemPrompt !== undefined && { systemPrompt }),
    turnContext: buildStructuredOutputTurnContext(undefined, responseSchema, adapterCapabilities),
    ...(responseSchema !== undefined && { responseSchema }),
  };
  const startResult = await connector.start(normalizedMessage, startOptions);
  const result = await startResult.messageHandle.waitForCompletion();
  const text = result.result?.message ?? '';
  if (responseSchema === undefined || result.outcome !== 'completed') {
    return text;
  }
  return validateInferStructuredOutput({ connector, manager, responseSchema, startResult, text });
}

/**
 * Await inference and close its connector runtime while preserving both failures.
 * @param execution - In-flight inference operation
 * @param runtime - Connector and auth lease owned by the operation
 * @param adapterName - Adapter name used in aggregate diagnostics
 * @returns Completed inference text
 */
async function completeInferenceRuntime<TConnector extends Pick<AIAgentConnector, 'close'>>(
  execution: Promise<string>,
  runtime: import('../agent/connector-runtime.js').ConnectorRuntimeHandle<TConnector>,
  adapterName: string,
): Promise<string> {
  let text = '';
  let inferenceError: unknown;
  try {
    text = await execution;
  } catch (error) {
    inferenceError = error;
  }

  let cleanupError: unknown;
  try {
    await closeConnectorRuntime(runtime);
  } catch (error) {
    cleanupError = error;
  }
  if (inferenceError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [inferenceError, cleanupError],
      `Ephemeral inference and connector cleanup both failed for ${adapterName}.`,
      { cause: inferenceError },
    );
  }
  if (inferenceError !== undefined) {
    throw inferenceError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return text;
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
        requestCorrelation: startResult.messageHandle.requestCorrelation,
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
