import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/** Canonical skill scope ordering. Narrower scopes win during effective resolution. */
export const SkillScopeSchema = z.enum(['global', 'project', 'session']);

/** Source of a discovered skill. */
export const SkillSourceSchema = z.enum(['filesystem', 'database']);

/** Activation behavior for a skill at runtime. */
export const SkillActivationModeSchema = z.enum(['manual', 'auto']);

/** Trigger that activated or reinjected a skill. */
export const SkillActivationTriggerSchema = z.enum(['model', 'user', 'auto', 'reinjection']);

/** Why a previously-active skill was removed from runtime state. */
export const SkillDeactivationReasonSchema = z.enum(['cwd_changed', 'session_end', 'user', 'replaced']);

/** Turn-count-only reinjection policy supported in Phase 1. */
export const SkillReinjectionSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
});

/**
 * Portable Agent Skills frontmatter contract.
 *
 * These fields are the only ones parsed from filesystem `SKILL.md` frontmatter
 * in Phase 1. Makaio-specific runtime policy remains separate.
 */
export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.string().optional(),
});

/** Makaio-owned runtime policy that augments the portable skill frontmatter. */
export const SkillRuntimePolicySchema = z.object({
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  adapters: z.array(z.string()).nullable().optional(),
  activationMode: SkillActivationModeSchema.default('manual'),
  reinjection: SkillReinjectionSchema.optional(),
  enabled: z.boolean().default(true),
});

/** Persisted database or discovered filesystem skill record. */
export const SkillRecordSchema = SkillFrontmatterSchema.merge(SkillRuntimePolicySchema).extend({
  id: z.string(),
  source: SkillSourceSchema,
  scope: SkillScopeSchema,
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  location: z.string().optional(),
  baseDir: z.string().optional(),
  content: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Runtime catalog entry presented to activation callers. */
export const SkillCatalogEntrySchema = z
  .object({
    name: SkillFrontmatterSchema.shape.name,
    description: SkillFrontmatterSchema.shape.description,
    compatibility: SkillFrontmatterSchema.shape.compatibility,
    category: SkillRuntimePolicySchema.shape.category,
    tags: SkillRuntimePolicySchema.shape.tags,
    adapters: SkillRuntimePolicySchema.shape.adapters,
    activationMode: SkillRuntimePolicySchema.shape.activationMode,
    source: SkillSourceSchema,
    scope: SkillScopeSchema,
    location: z.string().optional(),
    baseDir: z.string().optional(),
  })
  .strict();

/** Activation-time metadata that callers may need even when only the body is injected. */
export const ActivatedSkillMetadataSchema = z
  .object({
    license: SkillFrontmatterSchema.shape.license,
    compatibility: SkillFrontmatterSchema.shape.compatibility,
    allowedTools: SkillFrontmatterSchema.shape.allowedTools,
    metadata: SkillFrontmatterSchema.shape.metadata,
  })
  .strict();

/** Turn-context catalog entry for later runtime migration. */
export const SkillCatalogTurnEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  compatibility: z.string().optional(),
});

/** Turn-context active skill entry for later runtime migration. */
export const SkillTurnEntrySchema = z.object({
  name: z.string(),
  content: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  allowedTools: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

/** Public active-skill state returned by the service runtime API. */
export const ActiveSkillStateSchema = z.object({
  name: z.string(),
  content: z.string(),
  metadata: ActivatedSkillMetadataSchema.optional(),
  baseDir: z.string().optional(),
  resources: z.array(z.string()).optional(),
  trigger: SkillActivationTriggerSchema,
  activatedAt: z.number(),
  activatedAtTurn: z.number().int().positive().optional(),
  lastInjectedAtTurn: z.number().int().positive().optional(),
  reinjection: SkillReinjectionSchema.optional(),
});

/** Storage input for database-backed skill writes. */
export const SkillRecordInputSchema = SkillFrontmatterSchema.merge(SkillRuntimePolicySchema)
  .extend({
    id: z.string(),
    scope: SkillScopeSchema,
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
    content: z.string(),
    source: z.literal('database').default('database'),
  })
  .strict();

/** Skill query shape used by storage and catalog builders. */
export const SkillQuerySchema = z.object({
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  adapterId: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabledOnly: z.boolean().optional(),
});

/** Public skill lifecycle RPC and event schemas. */
export const SkillSchemas = {
  'catalog.built': z.object({
    sessionId: z.string(),
    agentId: z.string(),
    cwd: z.string(),
    adapterId: z.string().optional(),
    skillNames: z.array(z.string()),
    timestamp: z.number(),
  }),

  activated: z.object({
    sessionId: z.string(),
    agentId: z.string(),
    cwd: z.string(),
    adapterId: z.string().optional(),
    skillName: z.string(),
    trigger: SkillActivationTriggerSchema,
    turnNumber: z.number().int().positive().optional(),
    timestamp: z.number(),
  }),

  deactivated: z.object({
    sessionId: z.string(),
    agentId: z.string(),
    skillName: z.string(),
    reason: SkillDeactivationReasonSchema,
    timestamp: z.number(),
  }),

  getCatalog: {
    request: z.object({
      sessionId: z.string(),
      agentId: z.string(),
      cwd: z.string().optional(),
      projectId: z.string().optional(),
      adapterId: z.string().optional(),
    }),
    response: z.object({
      entries: z.array(SkillCatalogEntrySchema),
      cwd: z.string(),
    }),
  },

  activate: {
    request: z.object({
      sessionId: z.string(),
      agentId: z.string(),
      skillName: z.string(),
      trigger: SkillActivationTriggerSchema,
      cwd: z.string().optional(),
      projectId: z.string().optional(),
      adapterId: z.string().optional(),
      turnNumber: z.number().int().positive().optional(),
    }),
    response: z.object({
      name: z.string(),
      content: z.string(),
      metadata: ActivatedSkillMetadataSchema.optional(),
      baseDir: z.string().optional(),
      resources: z.array(z.string()).optional(),
      alreadyActive: z.boolean().default(false),
    }),
  },

  getActiveSkills: {
    request: z.object({
      sessionId: z.string(),
      agentId: z.string(),
      cwd: z.string().optional(),
      projectId: z.string().optional(),
      adapterId: z.string().optional(),
    }),
    response: z.object({
      skills: z.array(ActiveSkillStateSchema),
      cwd: z.string().optional(),
    }),
  },
} satisfies SchemaRecord;

export type SkillScope = z.infer<typeof SkillScopeSchema>;
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type SkillActivationMode = z.infer<typeof SkillActivationModeSchema>;
export type SkillActivationTrigger = z.infer<typeof SkillActivationTriggerSchema>;
export type SkillDeactivationReason = z.infer<typeof SkillDeactivationReasonSchema>;
export type SkillReinjection = z.infer<typeof SkillReinjectionSchema>;
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type SkillRuntimePolicy = z.infer<typeof SkillRuntimePolicySchema>;
export type SkillRecord = z.infer<typeof SkillRecordSchema>;
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;
export type ActivatedSkillMetadata = z.infer<typeof ActivatedSkillMetadataSchema>;
export type SkillCatalogTurnEntry = z.infer<typeof SkillCatalogTurnEntrySchema>;
export type SkillTurnEntry = z.infer<typeof SkillTurnEntrySchema>;
export type ActiveSkillState = z.infer<typeof ActiveSkillStateSchema>;
export type SkillRecordInput = z.infer<typeof SkillRecordInputSchema>;
export type SkillQuery = z.infer<typeof SkillQuerySchema>;
export type SkillGetCatalogRequest = z.infer<(typeof SkillSchemas)['getCatalog']['request']>;
export type SkillGetCatalogResponse = z.infer<(typeof SkillSchemas)['getCatalog']['response']>;
export type SkillActivateRequest = z.infer<(typeof SkillSchemas)['activate']['request']>;
export type SkillActivateResponse = z.infer<(typeof SkillSchemas)['activate']['response']>;
export type SkillGetActiveSkillsRequest = z.infer<(typeof SkillSchemas)['getActiveSkills']['request']>;
export type SkillGetActiveSkillsResponse = z.infer<(typeof SkillSchemas)['getActiveSkills']['response']>;
