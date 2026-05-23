// Shared schemas
export { BaseAdapterEventSchema } from './base-event.js';
export type { BaseAdapterEvent } from './base-event.js';
export { AdapterRuntimeOptionsSchema } from './runtime-options.js';
export type { AdapterRuntimeOptions } from './runtime-options.js';
export { AdapterSelectionSchema, AgentSelectionBaseSchema, AgentSelectionSchema } from './agent-resolution.js';
export type {
  AdapterSelection,
  AgentSelection,
  AgentSelectionBase,
  AgentSelectionKindMap,
} from './agent-resolution.js';
export { ProviderContextSchema } from './provider-context.js';
export type { ProviderContext } from './provider-context.js';

// RPC schemas
export { GetCapabilitiesSchema } from './get-capabilities.js';
export type { GetCapabilitiesRequest, GetCapabilitiesResponse } from './get-capabilities.js';
export { StartAgentSchema } from './start-agent.js';
export type { StartAgentRequest, StartAgentResponse } from './start-agent.js';
export { InferSchema } from './infer.js';
export type { InferRequest, InferResponse } from './infer.js';
export { ListAgentsSchema } from './list-agents.js';
export type { ListAgentsRequest, ListAgentsResponse } from './list-agents.js';
export { GetAgentSchema } from './get-agent.js';
export type { GetAgentRequest, GetAgentResponse } from './get-agent.js';
export { StopAgentSchema } from './stop-agent.js';
export type { StopAgentRequest, StopAgentResponse } from './stop-agent.js';
export { RehydrateAgentSchema } from './rehydrate-agent.js';
export type { RehydrateAgentRequest, RehydrateAgentResponse } from './rehydrate-agent.js';
export { GetConfigSchemaSchema } from './get-config-schema.js';
export type { GetConfigSchemaRequest, GetConfigSchemaResponse } from './get-config-schema.js';

// Event schemas
export { AgentCreatedSchema } from './agent-created.js';
export type { AgentCreated } from './agent-created.js';
export { SessionCreatedSchema } from './session-created.js';
export type { SessionCreated } from './session-created.js';
export { SessionUsageSchema } from './session-usage.js';
export type { SessionUsage } from './session-usage.js';
export { SessionClosedSchema } from './session-closed.js';
export type { SessionClosed } from './session-closed.js';
export { LogSchema } from './log.js';
export type { Log } from './log.js';
export { ErrorSchema } from './error.js';
export type { AdapterError } from './error.js';
export { InitializedSchema } from './initialized.js';
export type { Initialized } from './initialized.js';
export { QuotaSchema } from './quota.js';
export type { Quota } from './quota.js';
export { SessionDiscoveredSchema } from './session-discovered.js';
export type { SessionDiscovered } from './session-discovered.js';
export {
  COMPRESS_SESSION_LINEAGE_KIND,
  CompressSessionLineageSchema,
  FORK_SESSION_LINEAGE_KIND,
  ForkSessionLineageSchema,
  ROOT_SESSION_LINEAGE_KIND,
  RootSessionLineageSchema,
  SESSION_LINEAGE_KINDS,
  SessionLineageKindSchema,
  SessionLineageSchema,
  SUBAGENT_SESSION_LINEAGE_KIND,
  SubagentSessionLineageSchema,
} from './session-lineage.js';
export type { SessionLineage, SessionLineageKind } from './session-lineage.js';
