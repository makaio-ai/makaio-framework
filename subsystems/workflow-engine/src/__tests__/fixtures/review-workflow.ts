import { z } from 'zod';
import { codeStep, defineWorkflow } from '@makaio/contracts';
import type { ArtifactContext, JsonValue, PreviousStepOutput, StepContext } from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Review Workflow Data Schemas
// ─────────────────────────────────────────────────────────────

/**
 * A single finding from a review delegate.
 */
export const ReviewFindingSchema = z.object({
  /** Node or file that the finding refers to. */
  id: z.string(),
  /** Severity classification. */
  severity: z.enum(['info', 'warning', 'blocker']),
  /** Short human-readable summary. */
  message: z.string(),
  /** Optional extended detail. */
  detail: z.string().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * Aggregated findings across all review delegates.
 */
export const ReviewFindingsSchema = z.object({
  /** Spec-conformance findings from the spec delegate. */
  spec: z.array(ReviewFindingSchema),
  /** Code quality findings from the quality delegate. */
  quality: z.array(ReviewFindingSchema),
  /** Test-coverage findings from the test-coverage delegate. */
  testCoverage: z.array(ReviewFindingSchema),
});

export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;

/**
 * Primary artifact data shape for the review workflow.
 *
 * Tracks status, aggregated findings, and optional fix-iteration metadata.
 */
export const ReviewArtifactDataSchema = z.object({
  /**
   * Review lifecycle status.
   *
   * - `draft`    — review is being assembled
   * - `triaged`  — triage gate has been passed (approve path)
   * - `rejected` — triage gate rejected the review
   * - `fixed`    — post-fix iteration completed
   */
  status: z.enum(['draft', 'triaged', 'rejected', 'fixed']),
  /** Aggregated review findings. */
  findings: ReviewFindingsSchema,
  /**
   * Optional fix output produced by the fix iteration step.
   * Present only when the workflow enters the fix branch.
   */
  fixOutput: z.string().optional(),
});

export type ReviewArtifactData = z.infer<typeof ReviewArtifactDataSchema>;

/**
 * Triage gate resume data schema.
 *
 * The gate reviewer must supply an `action` and an optional rationale when
 * resuming from the triage checkpoint.
 */
export const TriageGateResumeSchema = z.object({
  /**
   * Whether the review should proceed to publish (`approve`) or stop (`reject`).
   */
  action: z.enum(['approve', 'reject']),
  /** Optional reviewer rationale for the decision. */
  rationale: z.string().optional(),
});

export type TriageGateResume = z.infer<typeof TriageGateResumeSchema>;

// ─────────────────────────────────────────────────────────────
// Delegate output shapes
// ─────────────────────────────────────────────────────────────

/** Output produced by each review agent step. */
export interface DelegateOutput {
  /** Findings discovered by this delegate. */
  findings: ReviewFinding[];
}

/** Output produced after applying the triage decision to the artifact status. */
interface TriageStatusOutput {
  /** Gate action that drove the artifact status update. */
  readonly action: TriageGateResume['action'];
  /** Artifact status written for the triage decision. */
  readonly status: 'triaged' | 'rejected';
}

// ─────────────────────────────────────────────────────────────
// Review Workflow Definition
// ─────────────────────────────────────────────────────────────

/**
 * Build the review workflow using the fluent builder API.
 *
 * Structure:
 * ```
 * parallel(review-delegates)
 *   ├─ spec delegate
 *   ├─ quality delegate
 *   └─ test-coverage delegate
 * codeStep(aggregate)        — merge findings into artifact
 * gate(triage)              — human triage checkpoint
 * codeStep(apply-triage-status) — persist approve/reject status
 * codeStep(apply-fix)?       — fix iteration (conditional on triage status)
 * ```
 *
 * The workflow binds to a `'code-review'` artifact so code steps can write
 * findings incrementally via `ctx.artifact.updateArtifact()`.
 * @param opts - Optional per-code-step handler overrides for testing.
 * @returns A fluent {@link WorkflowBuilder} ready to be executed.
 */
export function buildReviewWorkflow(opts?: {
  /** Override for the spec-review delegate handler. */
  readonly onSpec?: (ctx: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>) => Promise<DelegateOutput>;
  /** Override for the quality-review delegate handler. */
  readonly onQuality?: (ctx: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>) => Promise<DelegateOutput>;
  /** Override for the test-coverage delegate handler. */
  readonly onTestCoverage?: (ctx: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>) => Promise<DelegateOutput>;
  /** Override for the aggregate code step handler. */
  readonly onAggregate?: (ctx: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>, ReviewArtifactData>) => Promise<ReviewFindings>;
  /** Override for the fix code step handler. */
  readonly onFix?: (ctx: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>, ReviewArtifactData>) => Promise<string>;
}) {
  return defineWorkflow('review-workflow', {
    name: 'Code Review',
    description: 'Parallel spec, quality, and test-coverage review with triage gate and optional fix iteration.',
  })
    .artifact({
      kind: 'code-review',
      schemaVersion: 1,
      scope: { level: 'global' },
      schema: ReviewArtifactDataSchema,
      statusPath: 'status',
    })
    .parallel(
      'review-delegates',
      { mode: 'all-settled' },
      [
        codeStep('spec-review', async (ctx) => {
          const handler = opts?.onSpec;
          if (handler) {
            return handler(ctx as StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>);
          }
          return {
            findings: [
              { id: 'spec-1', severity: 'info', message: 'Spec check passed' },
            ],
          };
        }),
        codeStep('quality-review', async (ctx) => {
          const handler = opts?.onQuality;
          if (handler) {
            return handler(ctx as StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>);
          }
          return {
            findings: [
              { id: 'quality-1', severity: 'warning', message: 'Minor style issue' },
            ],
          };
        }),
        codeStep('test-coverage-review', async (ctx) => {
          const handler = opts?.onTestCoverage;
          if (handler) {
            return handler(ctx as StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>);
          }
          return {
            findings: [
              { id: 'coverage-1', severity: 'info', message: 'Coverage is adequate' },
            ],
          };
        }),
      ],
    )
    .codeStep(
      'aggregate',
      async (ctx) => {
        const typedCtx = ctx as StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>, ReviewArtifactData>;
        const handler = opts?.onAggregate;
        if (handler) {
          return handler(typedCtx);
        }

        // Default implementation: extract findings from parallel branch outputs.
        const parallelOutput = typedCtx.previousSteps['review-delegates'] as
          | { output: { branches: Record<string, { status: string; value?: unknown }> } }
          | undefined;

        const specFindings = extractDelegateFindingsFromBranch(parallelOutput, 'spec-review');
        const qualityFindings = extractDelegateFindingsFromBranch(parallelOutput, 'quality-review');
        const testCoverageFindings = extractDelegateFindingsFromBranch(parallelOutput, 'test-coverage-review');

        const findings: ReviewFindings = {
          spec: specFindings,
          quality: qualityFindings,
          testCoverage: testCoverageFindings,
        };

        // Write findings to the artifact if a binding is configured.
        if (typedCtx.artifact !== undefined) {
          const artifactCtx = typedCtx.artifact as ArtifactContext<ReviewArtifactData>;
          await artifactCtx.updateArtifact({
            operation: 'merge',
            data: { findings },
          });
          await artifactCtx.updateStatus('draft');
        }

        return findings;
      },
    )
    .gate('triage', {
      prompt: 'Review the findings and decide whether to approve or reject.',
      title: 'Triage Gate',
      autoAction: 'reject',
      timeoutMs: null,
      resume: TriageGateResumeSchema,
    })
    .codeStep('apply-triage-status', async (ctx) => {
      const typedCtx = ctx as StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>, ReviewArtifactData>;
      const triageOutput = typedCtx.previousSteps['triage']?.output;
      const resumeData =
        typeof triageOutput === 'object' && triageOutput !== null && !Array.isArray(triageOutput)
          ? (triageOutput as Record<string, unknown>)['resumeData']
          : undefined;
      const decision = TriageGateResumeSchema.parse(resumeData);
      const status: TriageStatusOutput['status'] = decision.action === 'approve' ? 'triaged' : 'rejected';

      if (typedCtx.artifact !== undefined) {
        const artifactCtx = typedCtx.artifact as ArtifactContext<ReviewArtifactData>;
        await artifactCtx.updateStatus(status);
      }

      return { action: decision.action, status } satisfies TriageStatusOutput;
    })
    .codeStep(
      'apply-fix',
      async (ctx) => {
        const typedCtx = ctx as StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>, ReviewArtifactData>;
        const handler = opts?.onFix;

        const fixOutput = handler
          ? await handler(typedCtx)
          : 'Applied suggested fixes from review findings.';

        // Write fix result to the artifact.
        if (typedCtx.artifact !== undefined) {
          const artifactCtx = typedCtx.artifact as ArtifactContext<ReviewArtifactData>;
          await artifactCtx.updateArtifact({
            operation: 'merge',
            data: { fixOutput },
          });
          await artifactCtx.updateStatus('fixed');
        }

        return fixOutput;
      },
      { when: "previousSteps['apply-triage-status'].output.action == 'approve'" },
    );
}

// ─────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────

/**
 * Extract findings from a named parallel branch output.
 *
 * The parallel node's output is a record of `{ status, value }` entries
 * keyed by branch name. Each fulfilled branch value should carry a
 * `{ findings: ReviewFinding[] }` payload.
 * @param parallelOutput - The parallel node's output as recorded in `previousSteps`.
 * @param branchKey - The branch key to extract findings for.
 * @returns The extracted findings array, or an empty array if absent.
 */
function extractDelegateFindingsFromBranch(
  parallelOutput:
    | { output: { branches: Record<string, { status: string; value?: unknown }> } }
    | undefined,
  branchKey: string,
): ReviewFinding[] {
  if (parallelOutput?.output?.branches === undefined) {
    return [];
  }
  const branch = parallelOutput.output.branches[branchKey];
  if (branch?.status !== 'fulfilled' || typeof branch.value !== 'object' || branch.value === null) {
    return [];
  }
  const value = branch.value as Record<string, unknown>;
  if (!Array.isArray(value['findings'])) {
    return [];
  }
  return value['findings'] as ReviewFinding[];
}
