import { z } from 'zod';
import { ConditionSchema as RuleConditionSchema } from '@makaio/rules/schemas';
import { MANAGED_INSTRUCTION_FILE_TARGETS } from './types.js';
import type {
  ContextRule,
  ContextRuleAction,
  ContextRuleChangedEvent,
  ContextRuleInput,
  ContextRuleListQuery,
  ContextRuleScopeIdentity,
  ContextRuleScopeFields,
} from './types.js';

/**
 * Base runtime facts accepted by the resolution service.
 */
export const ContextSnapshotBaseSchema = z
  .object({
    cwd: z.string().optional(),
    adapterId: z.string().optional(),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
  })
  .strict();

/**
 * Snapshot schema used in service responses.
 *
 * Host-owned snapshot extensions are preserved as unknown extra fields.
 */
export const ContextSnapshotSchema = ContextSnapshotBaseSchema.catchall(z.unknown());

/**
 * Allowlisted managed instruction file targets.
 */
export const ManagedInstructionFileTargetSchema = z.enum(MANAGED_INSTRUCTION_FILE_TARGETS);

/**
 * Action schema for turn-context delivery.
 */
export const TurnContextRuleActionSchema = z
  .object({
    channel: z.literal('turnContext'),
    content: z.string(),
    turnContextKey: z.string().optional(),
  })
  .strict();

/**
 * Action schema for managed-file delivery.
 */
export const FileContextRuleActionSchema = z
  .object({
    channel: z.literal('file'),
    content: z.string(),
    fileTarget: ManagedInstructionFileTargetSchema,
  })
  .strict();

/**
 * Discriminated action schema for persisted context rules.
 */
export const ContextRuleActionSchema = z.discriminatedUnion('channel', [
  TurnContextRuleActionSchema,
  FileContextRuleActionSchema,
]) as z.ZodType<ContextRuleAction, ContextRuleAction>;

/**
 * Persisted context-rule scope levels.
 */
export const ContextRuleScopeSchema = z.enum(['global', 'project', 'session']);

/**
 * Collect validation issues for scope-specific invariants.
 * @param rule - Rule-like object carrying scope fields
 * @returns Validation issues keyed to the offending fields
 */
function getScopeValidationIssues(
  rule: Pick<ContextRuleScopeFields, 'scope' | 'projectId' | 'sessionId'>,
): Array<{ path: Array<'projectId' | 'sessionId'>; message: string }> {
  if (rule.scope === 'global') {
    if (rule.projectId !== undefined || rule.sessionId !== undefined) {
      return [{ path: ['projectId'], message: 'Global scope context rules must not have projectId or sessionId' }];
    }
    return [];
  }

  if (rule.scope === 'project') {
    if (!rule.projectId) {
      return [{ path: ['projectId'], message: 'Project scope context rules require projectId' }];
    }
    if (rule.sessionId !== undefined) {
      return [{ path: ['sessionId'], message: 'Project scope context rules must not have sessionId' }];
    }
    return [];
  }

  if (!rule.sessionId) {
    return [{ path: ['sessionId'], message: 'Session scope context rules require sessionId' }];
  }

  return [];
}

/**
 * Validate scope invariants for a context rule input.
 *
 * Invariants:
 * - `global`: no `projectId`, no `sessionId`
 * - `project`: requires `projectId`, no `sessionId`
 * - `session`: requires `sessionId`, `projectId` optional
 * @param rule - Rule-like object carrying scope fields
 * @throws Error when the scope invariants are violated
 */
export function validateContextRuleScope(
  rule: Pick<ContextRuleScopeFields, 'scope' | 'projectId' | 'sessionId'>,
): void {
  const [issue] = getScopeValidationIssues(rule);
  if (issue) {
    throw new Error(issue.message);
  }
}

const ContextRuleInputBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    condition: RuleConditionSchema,
    action: ContextRuleActionSchema,
    priority: z.number(),
    enabled: z.boolean(),
    scope: ContextRuleScopeSchema,
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .strict();

/**
 * Context-rule upsert payload schema.
 */
export const ContextRuleInputSchema = ContextRuleInputBaseSchema.superRefine((rule, ctx) => {
  for (const issue of getScopeValidationIssues(rule)) {
    ctx.addIssue({
      code: 'custom',
      path: issue.path,
      message: issue.message,
    });
  }
}) as z.ZodType<ContextRuleInput, ContextRuleInput>;

/**
 * Persisted context-rule record schema.
 */
export const ContextRuleSchema = ContextRuleInputBaseSchema.extend({
  createdAt: z.number(),
  updatedAt: z.number(),
}).superRefine((rule, ctx) => {
  for (const issue of getScopeValidationIssues(rule)) {
    ctx.addIssue({
      code: 'custom',
      path: issue.path,
      message: issue.message,
    });
  }
}) as z.ZodType<ContextRule, ContextRule>;

/**
 * Storage-tier candidate query for scope-based listing.
 */
export const ContextRuleListQuerySchema = z
  .object({
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .strict() satisfies z.ZodType<ContextRuleListQuery, ContextRuleListQuery>;

/**
 * Normalized scope identity used for invalidation events.
 */
export const ContextRuleScopeIdentitySchema = z
  .object({
    scope: ContextRuleScopeSchema,
    projectId: z.string().nullable(),
    sessionId: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<ContextRuleScopeIdentity, ContextRuleScopeIdentity>;

/**
 * Service request schema for resolving rules against runtime facts.
 */
export const ContextRuleResolutionRequestSchema = ContextSnapshotBaseSchema;

/**
 * Matched rule output after template rendering.
 */
export const ResolvedContextRuleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    priority: z.number(),
    action: ContextRuleActionSchema,
    renderedContent: z.string(),
  })
  .strict();

const ResolvedFileBucketsSchema = z
  .object(
    Object.fromEntries(
      MANAGED_INSTRUCTION_FILE_TARGETS.map((fileTarget) => [fileTarget, z.array(ResolvedContextRuleSchema).optional()]),
    ),
  )
  .strict();

/**
 * Service response schema for grouped resolved rules.
 */
export const ResolvedContextRulesSchema = z
  .object({
    snapshot: ContextSnapshotSchema,
    turnContext: z.record(z.string(), z.array(ResolvedContextRuleSchema)),
    files: ResolvedFileBucketsSchema,
  })
  .strict();

/**
 * Lifecycle change event type for persisted context rules.
 */
export const ContextRuleChangedEventSchema = z
  .object({
    ruleId: z.string(),
    changeType: z.enum(['created', 'updated', 'deleted']),
    previous: ContextRuleScopeIdentitySchema.nullable(),
    current: ContextRuleScopeIdentitySchema.nullable(),
    timestamp: z.number(),
  })
  .strict() satisfies z.ZodType<ContextRuleChangedEvent, ContextRuleChangedEvent>;
