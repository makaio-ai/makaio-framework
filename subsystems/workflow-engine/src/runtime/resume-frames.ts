import type { JsonValue, WorkflowFrameState } from '@makaio/contracts';
import { buildPreviousStepsFromFrames, type PrimitiveExpressionContext } from './runtime-context.js';

// ─────────────────────────────────────────────────────────────
// Resume frame index
// ─────────────────────────────────────────────────────────────

/**
 * Lookup structure for pre-loaded resume frames in a re-dispatched execution.
 *
 * Provides two access paths over the same frame set:
 * - `byNodeId`: all frames that belong to a given node ID, ordered by insertion
 *   (which matches `startedAt` ascending when frames are loaded from storage via
 *   `listFrames`).
 * - `byFrameId`: direct O(1) lookup by frame ID.
 */
export interface ResumeFrameIndex {
  /** All frames for a given node ID, preserving storage order (startedAt asc). */
  readonly byNodeId: ReadonlyMap<string, readonly WorkflowFrameState[]>;
  /** Direct frame lookup by frame ID. */
  readonly byFrameId: ReadonlyMap<string, WorkflowFrameState>;
}

/**
 * Build a {@link ResumeFrameIndex} from a list of persisted frames.
 *
 * Returns `undefined` when `frames` is empty so callers can short-circuit
 * resume logic when there are no frames to resume from.
 * @param frames - Ordered frames loaded from storage (startedAt asc).
 * @returns Populated resume index, or `undefined` if the frame list is empty.
 */
export function buildResumeFrameIndex(frames: readonly WorkflowFrameState[]): ResumeFrameIndex | undefined {
  if (frames.length === 0) return undefined;
  const byNodeId = new Map<string, WorkflowFrameState[]>();
  const byFrameId = new Map<string, WorkflowFrameState>();
  for (const frame of frames) {
    byFrameId.set(frame.frameId, frame);
    const nodeFrames = byNodeId.get(frame.nodeId) ?? [];
    nodeFrames.push(frame);
    byNodeId.set(frame.nodeId, nodeFrames);
  }
  return { byNodeId, byFrameId };
}

// ─────────────────────────────────────────────────────────────
// Resume frame matching
// ─────────────────────────────────────────────────────────────

/**
 * Criteria used to match a persisted frame against a new frame being created
 * during a re-dispatched execution.
 */
export interface ResumeFrameMatchCriteria {
  /** Parent frame ID. Absent for root frames. */
  readonly parentFrameId?: string;
  /** Branch key for frames inside a parallel node. */
  readonly branchKey?: string;
  /** Zero-based iteration index for frames inside an iterate node. */
  readonly iteration?: number;
  /** Frame statuses that are safe for this caller to reuse. */
  readonly statuses?: ReadonlySet<WorkflowFrameState['status']>;
}

/** Terminal frame statuses that can be replayed without re-execution. */
const DEFAULT_REUSABLE_FRAME_STATUSES = new Set<WorkflowFrameState['status']>(['completed', 'skipped', 'waiting']);

/**
 * Find a previously persisted frame that can be reused during a re-dispatched
 * execution.
 *
 * Matches on `nodeId` combined with structural position coordinates
 * (`parentFrameId`, `branchKey`, `iteration`). By default only frames in a
 * terminal resumable status (`completed`, `skipped`, `waiting`) are considered.
 * Container executors may explicitly include `running` because a parked gate
 * leaves its ancestor structural frames running; reusing those ancestors is
 * what lets descendant frames keep the same durable parent identity.
 * @param index - Pre-built resume frame index, or `undefined` when no resume data is available.
 * @param nodeId - Node identifier of the frame being matched.
 * @param match - Structural position coordinates of the frame being created.
 * @returns The matching frame if one exists, otherwise `undefined`.
 */
export function findReusableResumeFrame(
  index: ResumeFrameIndex | undefined,
  nodeId: string,
  match: ResumeFrameMatchCriteria,
): WorkflowFrameState | undefined {
  const candidates = index?.byNodeId.get(nodeId) ?? [];
  const statuses = match.statuses ?? DEFAULT_REUSABLE_FRAME_STATUSES;
  return candidates.find(
    (frame) =>
      frame.parentFrameId === match.parentFrameId &&
      frame.branchKey === match.branchKey &&
      frame.iteration === match.iteration &&
      statuses.has(frame.status),
  );
}

// ─────────────────────────────────────────────────────────────
// Expression context merging
// ─────────────────────────────────────────────────────────────

/**
 * Terminal frame entry that can be merged into a {@link PrimitiveExpressionContext}.
 *
 * Discriminated on `status`:
 * - `completed`: the node finished successfully and may have produced output.
 * - `skipped`: the node was skipped by a `when` condition; no output is produced.
 */
type MergeableFrameEntry =
  | { readonly status: 'completed'; readonly output?: JsonValue }
  | { readonly status: 'skipped' };

/**
 * Merge a terminal frame entry for `nodeId` into an expression context.
 *
 * Produces a new context with the `frames`, `previousSteps`, and `output`
 * fields updated to reflect the completed or skipped node. The original
 * context is not mutated.
 * @param ctx - Current expression context.
 * @param nodeId - Node whose frame entry is being merged.
 * @param entry - Terminal frame entry to merge.
 * @returns Updated expression context reflecting the merged frame.
 */
export function mergeFrameOutput(
  ctx: PrimitiveExpressionContext,
  nodeId: string,
  entry: MergeableFrameEntry,
): PrimitiveExpressionContext {
  const frames = { ...ctx.frames, [nodeId]: entry };
  return {
    ...ctx,
    frames,
    previousSteps: buildPreviousStepsFromFrames(frames),
    output: entry.status === 'completed' ? entry.output : ctx.output,
  };
}
