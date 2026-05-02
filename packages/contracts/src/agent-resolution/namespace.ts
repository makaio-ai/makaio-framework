import { MakaioBus } from '@makaio/bus-core';
import { AgentResolutionSchemas } from './schemas.js';

// ============================================================================
// Agent Resolution Namespace
// ============================================================================

/**
 * Bus namespace for agent selection resolution.
 *
 * Single-seam design: framework handles `kind: 'adapter'` inline,
 * delegates all other kinds to `AgentResolutionSubjects.resolve`.
 * Host packages register a handler that dispatches on `kind` to
 * domain-specific services (persona, profile, virtual-model, etc.).
 *
 * This namespace is the architectural seam that eliminates the SOC
 * violation where framework code imported host subjects
 * (PersonaSubjects, ProfileSubjects, VirtualModelSubjects) directly.
 */
export const AgentResolutionNamespace = MakaioBus.registerNamespace('agentResolution', AgentResolutionSchemas);

/** Subject definitions for agent resolution bus RPCs. */
export const AgentResolutionSubjects = AgentResolutionNamespace.subjects;
