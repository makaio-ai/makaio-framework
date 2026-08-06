import type { IMakaioBus } from '@makaio/bus-core';
import type {
  AutomationTriggerActivationContext,
  AutomationTriggerCleanup,
  AutomationTriggerType,
  FindingSeverity,
  FindingTarget,
  ReviewFinding,
} from '@makaio/contracts';
import {
  FindingSeveritySchema,
  FindingTargetSchema,
  ReviewSubjects,
  defineAutomationTrigger,
  toAutomationTriggerType,
} from '@makaio/contracts';
import { z } from 'zod';
import { CODERABBIT_REVIEWER } from './source.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical kind of the CodeRabbit review-posted automation trigger. */
export const CODERABBIT_REVIEW_POSTED_TRIGGER_KIND = 'coderabbit.review-posted';

/** Log prefix for CodeRabbit automation trigger diagnostics. */
const LOG_PREFIX = '[CodeRabbitReviewPostedTrigger]';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Activation parameters for a CodeRabbit review-posted binding.
 *
 * Carries the repository scope only. Severity is deliberately absent: a
 * threshold is a condition a consumer evaluates over the emitted payload, not a
 * property of the source. Encoding it here would fork one trigger into one
 * activation per threshold and hide the filter from the workflow that depends
 * on it.
 */
const CodeRabbitReviewPostedParamsSchema = z.object({
  /** Repository identity to observe, matched exactly against `target.repository`. */
  repository: z.string().min(1),
});

/**
 * Per-severity distribution of the open CodeRabbit findings on the target.
 *
 * Keys are derived from {@link FindingSeveritySchema} so the payload cannot
 * drift from the review capability's severity vocabulary.
 */
const SeverityCountsSchema = z.object(
  Object.fromEntries(FindingSeveritySchema.options.map((severity) => [severity, z.number().int().nonnegative()])) as {
    readonly [Severity in FindingSeverity]: z.ZodNumber;
  },
);

/**
 * Event payload emitted when CodeRabbit findings arrive for an observed
 * repository.
 *
 * `severityCounts` and `highestSeverity` are what make a severity threshold
 * expressible as a consumer condition: a workflow gates on the emitted payload
 * instead of asking the source to pre-filter.
 */
export const CodeRabbitReviewPostedEventSchema = z.object({
  /** Repository/PR/branch the findings belong to. */
  target: FindingTargetSchema,
  /** Review source that produced the findings. */
  sourceId: z.string().min(1),
  /** Number of findings newly created by this arrival. */
  created: z.number().int().nonnegative(),
  /** Number of existing findings updated by this arrival. */
  updated: z.number().int().nonnegative(),
  /** Distribution of the target's currently open CodeRabbit findings. */
  severityCounts: SeverityCountsSchema,
  /** Most severe currently open finding, or `null` when none is open. */
  highestSeverity: FindingSeveritySchema.nullable(),
});

/** Event payload emitted by the CodeRabbit review-posted trigger. */
export type CodeRabbitReviewPostedEvent = z.output<typeof CodeRabbitReviewPostedEventSchema>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Counts findings per severity.
 * @param findings - Findings to summarize.
 * @returns Zero-filled count for every severity in the contract vocabulary.
 */
function countBySeverity(findings: readonly ReviewFinding[]): Record<FindingSeverity, number> {
  const counts = Object.fromEntries(FindingSeveritySchema.options.map((severity) => [severity, 0])) as Record<
    FindingSeverity,
    number
  >;
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * Picks the most severe severity that has at least one finding.
 *
 * Relies on {@link FindingSeveritySchema} declaring its options from most to
 * least severe, so the ranking lives in the contract rather than being restated
 * here.
 * @param counts - Per-severity counts.
 * @returns The highest represented severity, or `null` when all counts are zero.
 */
function highestRepresentedSeverity(counts: Record<FindingSeverity, number>): FindingSeverity | null {
  return FindingSeveritySchema.options.find((severity) => counts[severity] > 0) ?? null;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Builds the activation function for the CodeRabbit review-posted trigger.
 *
 * One activation observes one repository. The activation subscribes to the
 * per-source `review.findings.arrived` event, drops arrivals from other reviewer
 * families and other repositories, then reads the target's open CodeRabbit
 * findings so the emitted payload carries the severity distribution a consumer
 * needs to gate on.
 *
 * The severity summary is read from the review capability rather than recomputed
 * from the arrival counts: the counts say how much changed, not how severe the
 * target currently is, and only the latter is a useful workflow condition.
 *
 * The follow-up lookup and the emission are **awaited inside the handler**, so
 * they complete within the review service's awaited emit. That keeps this trigger
 * inside the bus completion barrier: the arrival cannot be reported as handled
 * while the derived event is still pending, an activation disposed right after the
 * fetch cannot silently swallow it, and two closely spaced arrivals for one
 * repository cannot emit out of order or both read the later findings snapshot.
 * The cost is latency — the review service's per-source announcement now waits for
 * one `review.findings.list` round trip. That request is served by a different
 * subject handler that only reads storage, so awaiting it here cannot deadlock
 * against the emit in flight.
 *
 * Failures are contained here rather than propagated: the bus rejects an emit
 * whose handler throws, so letting a failed lookup escape would report the review
 * service's own announcement as failed.
 * @param bus - Bus instance owned by the contributing extension.
 * @returns Activation function matching the trigger's typed contract.
 */
function activateCodeRabbitReviewPosted(
  bus: IMakaioBus,
): (
  context: AutomationTriggerActivationContext<CodeRabbitReviewPostedEvent>,
  params: z.output<typeof CodeRabbitReviewPostedParamsSchema>,
) => Promise<AutomationTriggerCleanup> {
  return async (context, params) =>
    bus.on(ReviewSubjects.findings.arrived, async (eventContext) => {
      const { target, sourceId, reviewer, created, updated } = eventContext.payload;
      if (reviewer !== CODERABBIT_REVIEWER) return;
      if (target.repository !== params.repository) return;

      const { correlationId } = eventContext;
      try {
        await emitReviewPosted(bus, context, {
          target,
          sourceId,
          created,
          updated,
          correlationId,
        });
      } catch (error) {
        console.error(`${LOG_PREFIX} emit failed for '${target.repository}':`, error);
      }
    });
}

/**
 * Identity, counts, and correlation carried by an observed findings arrival.
 */
interface ObservedFindingsArrival {
  /** Repository/PR/branch the findings belong to. */
  readonly target: FindingTarget;
  /** Review source that produced the findings. */
  readonly sourceId: string;
  /** Findings newly created by this arrival. */
  readonly created: number;
  /** Existing findings updated by this arrival. */
  readonly updated: number;
  /** Correlation identifier propagated from the arrival, when present. */
  readonly correlationId?: string;
}

/**
 * Reads the target's open CodeRabbit findings and emits the trigger event.
 *
 * Re-checks the activation signal after the lookup: the activation can be retired
 * while the request is in flight, and an emit made afterwards describes a
 * repository this activation is no longer observing.
 * @param bus - Bus used to read stored findings.
 * @param context - Activation context providing the typed emit channel.
 * @param arrival - Identity and counts carried by the observed arrival.
 * @returns Resolves once the event has been accepted by the runtime, or
 *   immediately when the activation was retired during the lookup.
 */
async function emitReviewPosted(
  bus: IMakaioBus,
  context: AutomationTriggerActivationContext<CodeRabbitReviewPostedEvent>,
  arrival: ObservedFindingsArrival,
): Promise<void> {
  const { findings } = await bus.request(ReviewSubjects.findings.list, {
    target: arrival.target,
    status: 'open',
  });
  if (context.signal.aborted) return;

  const severityCounts = countBySeverity(findings.filter((finding) => finding.sourceId === arrival.sourceId));

  await context.emit(
    {
      target: arrival.target,
      sourceId: arrival.sourceId,
      created: arrival.created,
      updated: arrival.updated,
      severityCounts,
      highestSeverity: highestRepresentedSeverity(severityCounts),
    },
    arrival.correlationId === undefined ? undefined : { correlationId: arrival.correlationId },
  );
}

// ---------------------------------------------------------------------------
// Trigger factory
// ---------------------------------------------------------------------------

/**
 * Creates the executable `coderabbit.review-posted` automation trigger.
 *
 * The bus is captured here, at trigger-creation time, from the contributing
 * extension's context — not from the activation context — so every activation
 * observes the same bus the extension was activated with.
 * @param bus - Bus instance owned by the contributing extension.
 * @returns The registry-boundary trigger type for `coderabbit.review-posted`.
 */
export function createCodeRabbitReviewPostedTrigger(bus: IMakaioBus): AutomationTriggerType {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind: CODERABBIT_REVIEW_POSTED_TRIGGER_KIND,
      label: 'CodeRabbit review posted',
      description: 'Emits a validated CodeRabbit review event for a configured repository.',
      categories: ['Code review'],
      paramsSchema: CodeRabbitReviewPostedParamsSchema,
      eventSchema: CodeRabbitReviewPostedEventSchema,
      activate: activateCodeRabbitReviewPosted(bus),
    }),
  );
}
