// Re-export all schemas and types from individual files
import type { SchemaRecord } from '@makaio/core';

// Import individual schemas for composition
import {
  GetCapabilitiesSchema,
  StartAgentSchema,
  InferSchema,
  ListAgentsSchema,
  GetAgentSchema,
  StopAgentSchema,
  RehydrateAgentSchema,
  AcknowledgeCallerSettlementSchema,
  GetConfigSchemaSchema,
  AgentCreatedSchema,
  SessionCreatedSchema,
  SessionDiscoveredSchema,
  SessionUsageSchema,
  SessionClosedSchema,
  LogSchema,
  ErrorSchema,
  InitializedSchema,
  DeinitializedSchema,
  QuotaSchema,
} from './schemas/index.js';

/**
 * Adapter domain schemas.
 *
 * Subjects for adapter-related bus communication.
 * Each key becomes a subject identifier as: `adapter.{key}`
 *
 * **Dotted keys become nested properties:**
 * Schema keys with dots (e.g., `'session.closed'`) are transformed into nested
 * subject accessors. Use dot notation to access them:
 * @example
 * ```typescript
 * // Schema key: 'session.closed' → Access as: AdapterSubjects.session.closed
 * bus.on(AdapterSubjects.session.closed, (ctx) => { ... });
 *
 * // Schema key: 'agent.created' → Access as: AdapterSubjects.agent.created
 * bus.on(AdapterSubjects.agent.created, (ctx) => { ... });
 *
 * // Non-dotted keys remain flat
 * bus.emit(AdapterSubjects.getCapabilities, { adapterName: 'claude' });
 * bus.emit(AdapterSubjects.startAgent, { ... });
 * ```
 */
export const AdapterSchemas = {
  getCapabilities: GetCapabilitiesSchema,
  startAgent: StartAgentSchema,
  infer: InferSchema,
  listAgents: ListAgentsSchema,
  getAgent: GetAgentSchema,
  stopAgent: StopAgentSchema,
  rehydrateAgent: RehydrateAgentSchema,
  acknowledgeCallerSettlement: AcknowledgeCallerSettlementSchema,
  getConfigSchema: GetConfigSchemaSchema,
  'agent.created': AgentCreatedSchema,
  'session.created': SessionCreatedSchema,
  'session.discovered': SessionDiscoveredSchema,
  'session.usage': SessionUsageSchema,
  'session.closed': SessionClosedSchema,
  log: LogSchema,
  error: ErrorSchema,
  initialized: InitializedSchema,
  deinitialized: DeinitializedSchema,
  quota: QuotaSchema,
} satisfies SchemaRecord;
