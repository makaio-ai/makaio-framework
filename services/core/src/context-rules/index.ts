/**
 * Context Rules Contracts
 *
 * Shared types, schemas, storage namespace, and service namespace for
 * persisted context rules and runtime resolution.
 * @packageDocumentation
 */

export { DEFAULT_CONTEXT_RULE_TURN_CONTEXT_KEY, MANAGED_INSTRUCTION_FILE_TARGETS } from './types.js';
export type {
  ContextRule,
  ContextRuleAction,
  ContextRuleChangedEvent,
  ContextRuleCondition,
  ContextRuleInput,
  ContextRuleListQuery,
  ContextRuleResolutionRequest,
  ContextRuleScope,
  ContextRuleScopeFields,
  ContextRuleScopeIdentity,
  ContextSnapshot,
  ContextSnapshotBase,
  ContextSnapshotExtensions,
  FileContextRuleAction,
  ManagedInstructionFileTarget,
  ResolvedContextRule,
  ResolvedContextRules,
  TurnContextRuleAction,
} from './types.js';
export {
  ContextRuleActionSchema,
  ContextRuleChangedEventSchema,
  ContextRuleInputSchema,
  ContextRuleListQuerySchema,
  ContextRuleResolutionRequestSchema,
  ContextRuleSchema,
  ContextRuleScopeIdentitySchema,
  ContextRuleScopeSchema,
  ContextSnapshotBaseSchema,
  ContextSnapshotSchema,
  FileContextRuleActionSchema,
  ManagedInstructionFileTargetSchema,
  ResolvedContextRuleSchema,
  ResolvedContextRulesSchema,
  TurnContextRuleActionSchema,
  validateContextRuleScope,
} from './schemas.js';
export { ContextRulesStorageNamespace, ContextRulesStorageSubjects } from './storage-namespace.js';
export { ContextRulesServiceNamespace, ContextRulesServiceSubjects } from './service-namespace.js';
