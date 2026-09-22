import { z } from 'zod';

import { JsonValueSchema } from '../shared/json-value.js';

/** A stable reference to an item considered during context projection. */
export const ContextProjectionRefSchema = z
  .object({
    /** Reference kind. */
    type: z.string().min(1),
    /** Stable identity within the reference kind. */
    id: z.string().min(1),
    /** Optional immutable revision identity. */
    revision: z.string().min(1).optional(),
  })
  .strict();

/** A stable reference to an item considered during context projection. */
export type ContextProjectionRef = z.infer<typeof ContextProjectionRefSchema>;

/** A reason recorded for an item selected or rejected during projection. */
export const ContextProjectionReasonSchema = z
  .object({
    /** Plan step that produced this reason. */
    step: z.string().min(1),
    /** Machine-readable reason code. */
    code: z.string().min(1),
  })
  .strict();

/** A reason recorded for an item selected or rejected during projection. */
export type ContextProjectionReason = z.infer<typeof ContextProjectionReasonSchema>;

/** An item occurrence together with the reasons recorded for it. */
export const ContextProjectionOccurrenceSchema = z
  .object({
    /** Item considered by the projection. */
    ref: ContextProjectionRefSchema,
    /** Reasons produced while considering the item. */
    reasons: z.array(ContextProjectionReasonSchema),
  })
  .strict();

/** An item occurrence together with the reasons recorded for it. */
export type ContextProjectionOccurrence = z.infer<typeof ContextProjectionOccurrenceSchema>;

/** One source-selection step in a context projection plan. */
export const ContextProjectionSelectStepSchema = z
  .object({
    /** Step discriminator. */
    op: z.literal('select'),
    /** Name assigned to this selected group. */
    as: z.string().min(1),
    /** Registered resolver that selects source occurrences. */
    resolver: z.string().min(1),
    /** Earlier selected group that scopes this resolver. */
    from: z.string().min(1).optional(),
    /** JSON-safe resolver input. */
    params: JsonValueSchema,
  })
  .strict();

/** One source-selection step in a context projection plan. */
export type ContextProjectionSelectStep = z.infer<typeof ContextProjectionSelectStepSchema>;

/** One value-projection step in a context projection plan. */
export const ContextProjectionProjectStepSchema = z
  .object({
    /** Step discriminator. */
    op: z.literal('project'),
    /** Name assigned to this projected group. */
    as: z.string().min(1),
    /** Registered resolver that projects values from selected occurrences. */
    resolver: z.string().min(1),
    /** Earlier selected group that supplies this resolver. */
    from: z.string().min(1),
    /** JSON-safe resolver input. */
    params: JsonValueSchema,
  })
  .strict();

/** One value-projection step in a context projection plan. */
export type ContextProjectionProjectStep = z.infer<typeof ContextProjectionProjectStepSchema>;

/** One named projected group included in a composed context. */
export const ContextProjectionComposeSectionSchema = z
  .object({
    /** Earlier projected group to include. */
    from: z.string().min(1),
    /** Label assigned to the composed section. */
    label: z.string().min(1),
  })
  .strict();

/** One named projected group included in a composed context. */
export type ContextProjectionComposeSection = z.infer<typeof ContextProjectionComposeSectionSchema>;

/** Optional contribution limit applied while composing a context. */
export const ContextProjectionComposeBudgetSchema = z
  .object({
    /** Maximum number of contributions included by composition. */
    maxContributions: z.number().int().positive(),
  })
  .strict();

/** Optional contribution limit applied while composing a context. */
export type ContextProjectionComposeBudget = z.infer<typeof ContextProjectionComposeBudgetSchema>;

/** The terminal composition step in a context projection plan. */
export const ContextProjectionComposeStepSchema = z
  .object({
    /** Step discriminator. */
    op: z.literal('compose'),
    /** Projected groups arranged as labelled context sections. */
    sections: z.array(ContextProjectionComposeSectionSchema),
    /** Optional contribution budget. */
    budget: ContextProjectionComposeBudgetSchema.optional(),
  })
  .strict();

/** The terminal composition step in a context projection plan. */
export type ContextProjectionComposeStep = z.infer<typeof ContextProjectionComposeStepSchema>;

/** Any declarative context projection plan step. */
export const ContextProjectionStepSchema = z.discriminatedUnion('op', [
  ContextProjectionSelectStepSchema,
  ContextProjectionProjectStepSchema,
  ContextProjectionComposeStepSchema,
]);

/** Any declarative context projection plan step. */
export type ContextProjectionStep = z.infer<typeof ContextProjectionStepSchema>;

/**
 * Declarative plan for selecting source occurrences, projecting values, and
 * composing the terminal context contribution sequence.
 */
export const ContextProjectionPlanSchema = z
  .object({
    /** Ordered projection steps; the sole compose step is always last. */
    steps: z.array(ContextProjectionStepSchema),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const namedGroups = new Set<string>();
    const selectedGroups = new Set<string>();
    const projectedGroups = new Set<string>();
    let composeCount = 0;

    plan.steps.forEach((step, index) => {
      if (step.op === 'compose') {
        composeCount += 1;
        for (const [sectionIndex, section] of step.sections.entries()) {
          if (!projectedGroups.has(section.from)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['steps', index, 'sections', sectionIndex, 'from'],
              message: 'compose sections must reference an earlier projected group',
            });
          }
        }
        return;
      }

      if (namedGroups.has(step.as)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'as'],
          message: 'named groups must be unique',
        });
      }
      namedGroups.add(step.as);

      if (step.op === 'select') {
        if (step.from !== undefined && !selectedGroups.has(step.from)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', index, 'from'],
            message: 'select steps must reference an earlier selected group',
          });
        }
        selectedGroups.add(step.as);
        return;
      }

      if (!selectedGroups.has(step.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'from'],
          message: 'project steps must reference an earlier selected group',
        });
      }
      projectedGroups.add(step.as);
    });

    if (composeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'context projection plans must contain exactly one compose step',
      });
    }
    if (plan.steps.at(-1)?.op !== 'compose') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'the compose step must be last',
      });
    }
  });

/** Declarative plan for a complete context projection. */
export type ContextProjectionPlan = z.infer<typeof ContextProjectionPlanSchema>;

/** Provenance retained for one projected JSON value. */
export const ContextProjectionValueProvenanceSchema = z
  .object({
    /** Source occurrence reference. */
    ref: ContextProjectionRefSchema,
    /** Reasons associated with the source occurrence. */
    reasons: z.array(ContextProjectionReasonSchema),
    /** Effective resolver selection preserved as JSON-safe data. */
    effectiveSelection: JsonValueSchema.optional(),
  })
  .strict();

/** Provenance retained for one projected JSON value. */
export type ContextProjectionValueProvenance = z.infer<typeof ContextProjectionValueProvenanceSchema>;

/** A JSON value produced by a projection resolver and its provenance. */
export const ContextProjectionProjectedValueSchema = z
  .object({
    /** JSON-safe value produced by the resolver. */
    value: JsonValueSchema,
    /** Source and selection details needed to explain the value. */
    provenance: ContextProjectionValueProvenanceSchema,
  })
  .strict();

/** A JSON value produced by a projection resolver and its provenance. */
export type ContextProjectionProjectedValue = z.infer<typeof ContextProjectionProjectedValueSchema>;

/** A projected value included in a labelled context section. */
export const ContextProjectionContributionSchema = z
  .object({
    /** JSON-safe value produced by the resolver. */
    value: JsonValueSchema,
    /** Source and selection details needed to explain the value. */
    provenance: ContextProjectionValueProvenanceSchema,
    /** Label of the composed section containing this contribution. */
    section: z.string().min(1),
    /** Zero-based order within the composed result. */
    order: z.number().int().nonnegative(),
  })
  .strict();

/** A projected value included in a labelled context section. */
export type ContextProjectionContribution = z.infer<typeof ContextProjectionContributionSchema>;

/** A warning or error emitted while evaluating a context projection plan. */
export const ContextProjectionDiagnosticSchema = z
  .object({
    /** Plan step that emitted the diagnostic. */
    step: z.string().min(1),
    /** Diagnostic severity. */
    severity: z.enum(['warning', 'error']),
    /** Machine-readable diagnostic code. */
    code: z.string().min(1),
    /** Human-readable diagnostic message. */
    message: z.string().min(1),
  })
  .strict();

/** A warning or error emitted while evaluating a context projection plan. */
export type ContextProjectionDiagnostic = z.infer<typeof ContextProjectionDiagnosticSchema>;

/** The serializable result of evaluating a context projection plan. */
export const ContextProjectionResultSchema = z
  .object({
    /** Ordered contributions that make up the composed context. */
    contributions: z.array(ContextProjectionContributionSchema),
    /** Warnings and errors encountered during evaluation. */
    diagnostics: z.array(ContextProjectionDiagnosticSchema),
  })
  .strict();

/** The serializable result of evaluating a context projection plan. */
export type ContextProjectionResult = z.infer<typeof ContextProjectionResultSchema>;
