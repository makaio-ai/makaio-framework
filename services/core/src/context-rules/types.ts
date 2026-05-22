import type { z } from 'zod';
import type { ConditionSchema as RuleConditionSchema } from '@makaio/rules/schemas';

/**
 * Default turn-context bucket used for rules that inject additional context.
 */
export const DEFAULT_CONTEXT_RULE_TURN_CONTEXT_KEY = 'contextRules';

/**
 * Allowlisted managed instruction files owned by Context Rules.
 */
export const MANAGED_INSTRUCTION_FILE_TARGETS = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'COPILOT.md',
  'CURSOR.md',
] as const;

/**
 * Base snapshot fields available from current runtime seams.
 *
 * Host-owned fields are added through declaration merging on
 * {@link ContextSnapshotExtensions}.
 */
export interface ContextSnapshotBase {
  /** Current working directory for the active agent/runtime, when known. */
  cwd?: string;
  /** Adapter identifier for the active agent/runtime, when known. */
  adapterId?: string;
  /** Makaio session identifier, when the runtime is attached to a session. */
  sessionId?: string;
  /** Active agent identifier, when resolution is tied to a specific agent. */
  agentId?: string;
}

/* eslint-disable @typescript-eslint/no-empty-object-type */
/**
 * Host-owned declaration merge target for snapshot enrichment.
 *
 * Augment `@makaio/services-core/context-rules` from host code rather than
 * widening the root services-core module.
 */
export interface ContextSnapshotExtensions {}
/* eslint-enable @typescript-eslint/no-empty-object-type */

/**
 * Fully resolved snapshot shape used for condition evaluation and rendering.
 */
export type ContextSnapshot = ContextSnapshotBase & ContextSnapshotExtensions;

/**
 * Allowlisted managed instruction file target.
 */
export type ManagedInstructionFileTarget = (typeof MANAGED_INSTRUCTION_FILE_TARGETS)[number];

/**
 * Scope levels supported by persisted context rules.
 */
export type ContextRuleScope = 'global' | 'project' | 'session';

/**
 * Any condition supported by context-rule resolution.
 */
export type ContextRuleCondition = z.infer<typeof RuleConditionSchema>;

/**
 * Rule action that injects rendered content into turn context.
 */
export interface TurnContextRuleAction {
  /** Delivery channel for the rendered rule content. */
  channel: 'turnContext';
  /** Template content rendered against the resolved snapshot. */
  content: string;
  /** Optional turn-context bucket key. Defaults to `contextRules`. */
  turnContextKey?: string;
}

/**
 * Rule action that projects rendered content into a managed root file.
 */
export interface FileContextRuleAction {
  /** Delivery channel for the rendered rule content. */
  channel: 'file';
  /** Template content rendered against the resolved snapshot. */
  content: string;
  /** Managed instruction file that receives the rendered projection. */
  fileTarget: ManagedInstructionFileTarget;
}

/**
 * Supported context-rule action payloads.
 */
export type ContextRuleAction = TurnContextRuleAction | FileContextRuleAction;

/**
 * Scope fields shared by rule inputs and persisted rule records.
 */
export interface ContextRuleScopeFields {
  /** Hierarchical scope deciding when the rule is a candidate. */
  scope: ContextRuleScope;
  /** Project identifier for project scope and optionally project-bound session scope. */
  projectId?: string;
  /** Session identifier for session-scoped rules. */
  sessionId?: string;
}

/**
 * Write payload for creating or updating a context rule.
 */
export interface ContextRuleInput extends ContextRuleScopeFields {
  /** Stable rule identifier. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Optional description for diagnostics or UI display. */
  description?: string;
  /** Predicate tree that decides whether the rule matches. */
  condition: ContextRuleCondition;
  /** Delivery action attached to matching rules. */
  action: ContextRuleAction;
  /** Deterministic ordering key for matching rules. */
  priority: number;
  /** Whether the rule is active during resolution. */
  enabled: boolean;
}

/**
 * Persisted context rule record.
 */
export interface ContextRule extends ContextRuleInput {
  /** Creation timestamp in Unix milliseconds. */
  createdAt: number;
  /** Last update timestamp in Unix milliseconds. */
  updatedAt: number;
}

/**
 * Scope-based candidate query for storage-tier listing.
 */
export interface ContextRuleListQuery {
  /** Optional project identifier used to include project-scoped candidates and disambiguate project-bound session rules. */
  projectId?: string;
  /** Optional session identifier used to include session-scoped candidates. */
  sessionId?: string;
}

/**
 * Normalized scope identity used for cache invalidation.
 */
export interface ContextRuleScopeIdentity {
  /** Hierarchical scope deciding when the rule is a candidate. */
  scope: ContextRuleScope;
  /** Project identifier normalized to `null` when not part of the scope key. */
  projectId: string | null;
  /** Session identifier normalized to `null` when not part of the scope key. */
  sessionId: string | null;
}

/**
 * Service request for resolving matching rules against the current runtime.
 */
export type ContextRuleResolutionRequest = ContextSnapshotBase;

/**
 * A matched rule after template rendering.
 */
export interface ResolvedContextRule {
  /** Stable rule identifier. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Deterministic sort key preserved in the resolved output. */
  priority: number;
  /** Original action payload for the matching rule. */
  action: ContextRuleAction;
  /** Template-rendered content for the concrete snapshot. */
  renderedContent: string;
}

/**
 * Service response grouping matched rules by delivery channel.
 */
export interface ResolvedContextRules {
  /** Concrete snapshot used for evaluation and rendering. */
  snapshot: ContextSnapshot;
  /** Resolved turn-context entries grouped by bucket key. */
  turnContext: Record<string, ResolvedContextRule[]>;
  /** Resolved managed-file entries grouped by file target. */
  files: Partial<Record<ManagedInstructionFileTarget, ResolvedContextRule[]>>;
}

/**
 * Lifecycle event emitted whenever persisted context rules change.
 */
export interface ContextRuleChangedEvent {
  /** Rule identifier that changed. */
  ruleId: string;
  /** Type of storage mutation that occurred. */
  changeType: 'created' | 'updated' | 'deleted';
  /** Scope identity before the mutation, or `null` for newly created rules. */
  previous: ContextRuleScopeIdentity | null;
  /** Scope identity after the mutation, or `null` for deleted rules. */
  current: ContextRuleScopeIdentity | null;
  /** Mutation timestamp in Unix milliseconds. */
  timestamp: number;
}
