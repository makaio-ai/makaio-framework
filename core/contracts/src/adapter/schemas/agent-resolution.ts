import { z } from 'zod';
import { AIReasoningLevelSchema } from '../../model/index.js';
import { McpRuntimeSessionContextSchema } from '../../mcp/schemas.js';
import { SystemPromptSchema } from '../../shared/index.js';
import { JsonObjectContractSchema } from '../../shared/json-value.js';

// ============================================================================
// AgentSelection — extensible agent configuration hint
// ============================================================================

/**
 * Common fields shared by all agent selection kinds.
 *
 * Every `AgentSelection` carries a `kind` discriminant (an open string,
 * not a closed enum) plus optional overrides that apply **after**
 * resolution, regardless of how the agent config was resolved.
 *
 * Framework defines `kind: 'adapter'` (direct adapter specification).
 * Host packages register resolvers for additional kinds (e.g. persona,
 * profile, virtual-model) via `AgentResolutionSubjects.resolve`.
 *
 * Defined as a **loose object** (`z.looseObject`) so kind-specific fields
 * (e.g. `personaId`, `profileId`) survive Zod validation when this schema
 * is used as the wire-level validator. Per-kind validation happens in the
 * host-tier resolver, not at the bus transport layer.
 */
export const AgentSelectionBaseSchema = z.looseObject({
  /**
   * Resolution strategy discriminant.
   *
   * Open string — framework handles `'adapter'`, host registers
   * resolvers for additional kinds. Unknown kinds are resolved via
   * `AgentResolutionSubjects.resolve` bus RPC.
   */
  kind: z.string(),

  // ── Credential override (orthogonal to resolution strategy) ────────────

  /**
   * Provider config UUID — "use these credentials."
   *
   * Links to a persisted ProviderConfig with endpoint overrides and a
   * normalized authentication selection. Orthogonal to resolution strategy: resolution
   * produces an adapter + model, this field selects which
   * account/credentials to use for the API call.
   *
   * When omitted, provider selection resolves through this chain:
   * 1. Persona/profile/virtualModel resolution may produce a
   *    `providerConfigId` from the resolved entity
   * 2. If still absent, the adapter receives the closed unresolved
   *    `ProviderContext` state. That state grants neither ambient environment
   *    authentication nor native-client authentication.
   *
   * Renamed from the legacy wire name `providerId` for clarity — this
   * points to a ProviderConfig instance, not a ProviderDefinition.
   */
  providerConfigId: z.string().optional(),

  // ── Runtime overrides (apply after resolution, any kind) ───────────────

  /** Model identifier (e.g., `'sonnet'`, `'gpt-4o'`). Overrides resolved model. */
  model: z.string().optional(),

  /** Reasoning effort level. Overrides resolved reasoning effort. */
  reasoningEffort: AIReasoningLevelSchema.optional(),

  /** Working directory for agent execution. */
  cwd: z.string().optional(),

  /**
   * System prompt configuration.
   *
   * - `string`: Replace/set the entire system prompt.
   * - `{ mode: 'append', content: string }`: Append to the resolved system prompt.
   */
  systemPrompt: SystemPromptSchema.optional(),

  /** Allowed tool names (adapter-specific). Empty array = disable all tools. */
  allowedTools: z.array(z.string()).optional(),

  /** Disallowed tool names (adapter-specific). Takes precedence over allowedTools. */
  disallowedTools: z.array(z.string()).optional(),

  /** Environment variables to pass to agent execution. */
  env: z.record(z.string(), z.string()).optional(),

  /** MCP session context with caller-provided servers and tools. */
  mcpSessionContext: McpRuntimeSessionContextSchema.optional(),

  /**
   * Directory restrictions for file-system tool execution.
   *
   * - `undefined`: no restriction (use adapter/runtime defaults)
   * - `[]`: deny all filesystem paths
   * - non-empty array: restrict access to listed directories
   */
  allowedDirectories: z.array(z.string()).optional(),

  /** Per-call adapter-specific configuration. Forwarded to startAgent. */
  adapterConfig: JsonObjectContractSchema.optional(),
});

export type AgentSelectionBase = z.infer<typeof AgentSelectionBaseSchema>;

// ============================================================================
// kind: 'adapter' — framework-native, no host resolver needed
// ============================================================================

/**
 * Direct adapter specification.
 *
 * The only kind the framework can resolve without host-tier resolvers.
 * Specifies the adapter driver to use. `adapterName` may be omitted when an
 * `adapterId` is provided for unambiguous multi-host targeting; startup paths
 * backfill the name when the runtime already knows it.
 *
 * **Naming an instance means naming its machine, and naming a machine means
 * naming an instance.** The two are one key: an instance ID cannot be inverted
 * back to the machine it was derived for, and a machine named on its own is read
 * by nothing — see {@link AdapterSelectionSchema.machineId}. Either half alone is
 * refused.
 * @example
 * ```typescript
 * const selection: AdapterSelection = {
 *   kind: 'adapter',
 *   adapterId: 'adapter-123',
 *   machineId: 'machine-a',
 *   model: 'sonnet',
 * };
 * ```
 */
export const AdapterSelectionSchema = AgentSelectionBaseSchema.extend({
  kind: z.literal('adapter'),

  /**
   * Adapter driver name (e.g., `'anthropic-sdk'`, `'openai-node'`).
   *
   * When `adapterId` is omitted, this is resolved via the adapter registry to
   * an `adapterId`. When `adapterId` is provided, `adapterName` can be omitted
   * and is backfilled from adapter storage.
   *
   * When multiple hosts serve the same adapter name, the local adapter is
   * preferred.
   */
  adapterName: z.string().trim().min(1).optional(),

  /**
   * Adapter instance UUID for unambiguous multi-host targeting.
   *
   * In a multi-host bus topology, multiple adapters may share the same
   * `adapterName`. When provided, `adapterId` bypasses name-based
   * resolution and targets the specific adapter instance directly.
   *
   * Resolution with both fields: `adapterId` takes precedence and
   * `adapterName` is backfilled from adapter storage when omitted.
   */
  adapterId: z.string().trim().min(1).optional(),

  /**
   * Machine the named instance belongs to.
   *
   * **Required whenever `adapterId` is supplied, and omitted otherwise.** An
   * instance ID is derived from `(machineId, adapterName)` and the derivation is
   * one-way, so an instance cannot name its own machine. An ownership act keyed
   * on a caller-named instance under the *resolving* runtime's machine therefore
   * builds a key unique to the mistake: no other actor computes it, so it
   * collides with nothing and protects nothing, and the runtime that really owns
   * that instance claims the same provider session beside it.
   *
   * Omitted with only `adapterName`, resolution derives the instance for the
   * resolving runtime's own machine and every ownership act names that same
   * identity — the existing and correct behaviour.
   *
   * **Refused without `adapterId`, rather than ignored.** Resolution reads this
   * field only on the branch a named instance takes, so the other branch would
   * accept it and derive the instance for the *resolving* runtime's machine
   * anyway. A caller left believing its machine was honoured is one step from a
   * caller whose belief becomes a real mis-key, which is the defect the
   * requirement above exists to refuse.
   */
  machineId: z.string().trim().min(1).optional(),
})
  .refine((value) => Boolean(value.adapterName) || Boolean(value.adapterId), {
    message: "AdapterSelection requires at least one of 'adapterName' or 'adapterId'",
  })
  .refine((value) => !value.adapterId || Boolean(value.machineId), {
    message: "AdapterSelection requires 'machineId' when 'adapterId' is supplied",
    path: ['machineId'],
  })
  .refine((value) => !value.machineId || Boolean(value.adapterId), {
    message: "AdapterSelection requires 'adapterId' when 'machineId' is supplied",
    path: ['adapterId'],
  });

export type AdapterSelection = z.infer<typeof AdapterSelectionSchema>;

// ============================================================================
// AgentSelectionKindMap — extensible discriminated union via declaration merging
// ============================================================================

/**
 * Interface map for the `AgentSelection` discriminated union.
 *
 * Framework registers `'adapter'` here. Host or application packages widen the union
 * by augmenting this interface via
 * [declaration merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html):
 *
 * ```typescript
 * // In an application package's selection module
 * declare module '@makaio/contracts' {
 *   interface AgentSelectionKindMap {
 *     persona: PersonaSelection;
 *   }
 * }
 * ```
 *
 * This gives compile-time narrowing (`switch(agent.kind)`) for all
 * registered kinds while keeping the Zod wire schema open (`kind: z.string()`).
 */

export interface AgentSelectionKindMap {
  adapter: AdapterSelection;
}

/**
 * Agent configuration selection for `sendMessage` and `agent.attach`.
 *
 * Discriminated union on `kind`. Framework defines `'adapter'`; host
 * tiers extend via declaration merging on {@link AgentSelectionKindMap}.
 *
 * For bus payloads that must accept unknown host kinds, use
 * {@link AgentSelectionBaseSchema} (accepts any `kind` string).
 */
export type AgentSelection = AgentSelectionKindMap[keyof AgentSelectionKindMap];

/**
 * Wire-level Zod schema for agent selection payloads.
 *
 * Alias for {@link AgentSelectionBaseSchema} — validates base fields only
 * (open `kind: z.string()`, common overrides). Kind-specific fields pass
 * through via the loose object and are validated by host-tier resolvers.
 *
 * The inferred type is `AgentSelectionBase` (open `kind: string` + index
 * signature). For the narrowed compile-time union, use the
 * {@link AgentSelection} type after resolver validation.
 */
export const AgentSelectionSchema = AgentSelectionBaseSchema;
