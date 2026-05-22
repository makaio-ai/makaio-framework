import { createBusNamespace } from '@makaio/core';
import { AgentRuntimeSchemas } from './schemas.js';

// ============================================================================
// Agent Runtime Namespace
// ============================================================================

/**
 * Bus namespace for tool-spawned agent lifecycle.
 *
 * Framework-tier replacement for `PersonaRuntimeSubjects` and
 * `ProfileRuntimeSubjects`. Framework tools import only this namespace;
 * host tiers register a handler that dispatches on `agent.kind`.
 *
 * This eliminates the SOC violation where framework tools imported
 * host-domain subjects (`PersonaRuntimeSubjects`, `ProfileRuntimeSubjects`)
 * directly.
 */
export const AgentRuntimeNamespace = createBusNamespace('agentRuntime', AgentRuntimeSchemas);

/** Subject definitions for agent runtime bus RPCs. */
export const AgentRuntimeSubjects = AgentRuntimeNamespace.subjects;
