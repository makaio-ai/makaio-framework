export { AIAgentConnector } from '../connector/index.js';
export { CONNECTOR_EXIT_OBSERVATION_MS } from '../connector/index.js';
export { BaseConnectorSession, type ConnectorSessionConfig } from '../connector/base-connector-session.js';
export { BaseConnectorTurn, type PauseResult } from '../connector/base-connector-turn.js';
export {
  ProceduralConnectorTurn,
  type TurnSubjects,
  type ProceduralTurnState,
  type ProceduralTurnConfig,
} from '../connector/procedural-connector-turn.js';
export {
  ProceduralAgentConnector,
  type ProceduralConnectorSession,
  type WireSessionSubjects,
  type WireSessionConfig,
} from '../connector/procedural-agent-connector.js';
export { AIAgent } from './ai-agent.js';
export { AgentEventBridge, type AgentEventBridgeConfig } from './agent-event-bridge.js';
export {
  AgentTurnExecutor,
  type AgentTurnExecutorConfig,
  type ShouldUseNativeResumeFn,
} from './agent-turn-executor.js';
// `AgentConnectorLifecycleManager` is deliberately **not** exported. It is the
// sole connector-replacement mechanism, and while it was publicly constructible a
// caller could build one with a config of its own and replace a connector without
// passing the arbitration door — the one hole a door-shaped seam can have.
// Unexporting it is what makes "one door" a property of the module rather than a
// convention. Its diagnostic and config types travel with it.
export {
  AgentTeardownArbiter,
  type ClosableConnectorRuntime,
  type ConnectorReplacementSettlement,
  type ConnectorSwapAdmission,
  type ConnectorSwapHandover,
  type TeardownSubject,
} from './agent-teardown-arbiter.js';
export { ConnectorSwapVetoedError, type ConnectorSwapVetoReason } from './connector-swap-vetoed-error.js';
export {
  aggregateTeardownReports,
  rethrowTeardownFailure,
  unknownTeardown,
  type TeardownReport,
} from '../connector/teardown-report.js';
export { SWAP_SETTLEMENT_WAIT_MS } from '../connector/teardown-timing.js';
export {
  capTeardownEvidence,
  describeTeardownFailure,
  exitWasObserved,
  reportBestEffortStages,
  reportObservedExit,
  reportRepeatTeardown,
  runBestEffortStage,
  stageFailure,
  type ObservedExitOptions,
} from '../connector/teardown-observation.js';
export { GenerationRetirementLedger, type SupersededGeneration } from '../connector/generation-retirement.js';
export {
  closeConnectorRuntime,
  createConnectorRuntime,
  type ConnectorRuntimeHandle,
  type CreateConnectorRuntimeOptions,
} from './connector-runtime.js';
export { AgentLifecycleEmitter, type AgentLifecycleEmitterConfig } from './agent-lifecycle-emitter.js';
export { AgentPayloadEmitter, type AgentPayloadEmitterConfig } from './agent-payload-emitter.js';
export { registerAgentBusHandlers, type AgentBusHandlerRegistrarConfig } from './agent-bus-handler-registrar.js';
// Part of the public AIAgent.swapConnector signature; the decomposition
// internals behind it (config-input builder, retry transform) stay unexported.
export type { AgentConnectorConfigOverrides } from './types.js';
export { AgentRuntimeMutationManager } from './agent-runtime-mutation-manager.js';
export type { AgentRuntimeMutationManagerConfig } from './agent-runtime-mutation-manager-config.js';
export { MessageLifecycleTracker } from './message-lifecycle-tracker.js';
export { ToolCallTracker, type ResolveHints } from './tool-call-tracker.js';
export { SessionToolLedger } from './session-tool-ledger.js';
export type { ISessionToolLedger, ToolLedgerEntry, LedgerSessionContext } from './session-tool-ledger.js';
export { extractMcpCallTarget, isMcpCallTool } from './mcp-call-extractor.js';
export {
  bindProviderRequestCorrelation,
  buildFactoryUsageCorrelationHeaders,
  FactoryUsageCorrelationHeaders,
} from './request-correlation.js';
export type { ProviderRequestCorrelation } from './request-correlation.js';
export type { AIAgentConfig, AgentContext, AgentIdentity, NormalizedCallUsage } from './types.js';
// Re-export MessageHandle from message-handle folder
export { MessageHandle } from '../message-handle/index.js';
export type {
  BaseAgentConnectorConfig,
  AgentStartResult,
  StartAgentOptions,
  AgentSendMessageOptions,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
  ExecutionContext,
} from './types.js';
