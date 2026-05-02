import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage, IMakaioSession, ForkTransforms, SegmentPolicy } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { buildSessionContext } from './build-context.js';
import { executePipeline } from '../session-editor/pipeline-executor.js';
import type { ContextAssemblyResult } from './types.js';
import { stripReasoningBlocks } from '../session-editor/actions/strip-reasoning.js';
import { stripToolOutputBlocks } from '../session-editor/actions/strip-tool-outputs.js';

/**
 * Get full conversation for a session, traversing parent chain.
 *
 * For forked sessions, this walks up the parent chain and assembles
 * messages from each ancestor, respecting forkPointMessageId boundaries.
 *
 * IMPORTANT: forkPointMessageId must be a Makaio message ID (not adapter ID).
 * Normalization happens at adapter session link time.
 * @param bus - Bus instance for RPC calls
 * @param sessionId - Session to get conversation for
 * @returns Full conversation with lineage
 */
export async function getFullConversation(bus: IMakaioBus, sessionId: string): Promise<ContextAssemblyResult> {
  const sessionChain: string[] = [];
  let ancestorMessages: SessionMessage[] = [];
  let targetMessages: SessionMessage[] = [];
  let hasSquashBoundary = false;
  let truncated = false;
  let incomplete = false;

  // Build chain from target session up to root
  const chain: Array<{
    sessionId: string;
    forkPointMessageId?: string;
  }> = [];

  // Store target session's transforms (only applies to inherited ancestor context)
  let targetTransforms: ForkTransforms | undefined;

  let currentSessionId: string | undefined = sessionId;
  let expectedParentId: string | undefined;

  while (currentSessionId) {
    const sessionResult: { session: IMakaioSession | null } = await bus.request(SessionStorageSubjects.get, {
      sessionId: currentSessionId,
    });

    if (!sessionResult.session) {
      // Parent chain is broken - session not found
      incomplete = true;
      break;
    }

    // Capture transforms from the target session (first iteration only)
    if (currentSessionId === sessionId) {
      targetTransforms = sessionResult.session.forkTransforms ?? undefined;
    }

    chain.unshift({
      sessionId: currentSessionId,
      forkPointMessageId: sessionResult.session.forkPointMessageId ?? undefined,
    });

    expectedParentId = sessionResult.session.parentSessionId ?? undefined;
    currentSessionId = expectedParentId;
  }

  // Process chain from root to target
  for (let i = 0; i < chain.length; i++) {
    const { sessionId: chainSessionId } = chain[i];
    const isLast = i === chain.length - 1;
    const nextForkPoint = chain[i + 1]?.forkPointMessageId;

    sessionChain.push(chainSessionId);

    // Build context for this session
    const result = await buildSessionContext(bus, { sessionId: chainSessionId });

    if (result.hasSquashBoundary) {
      hasSquashBoundary = true;
      // Squash in an ANCESTOR session clears prior ancestors (squash replaces history up to that point)
      // Squash in the TARGET session does NOT clear ancestors (squash only replaces target's own messages)
      if (!isLast) {
        ancestorMessages.length = 0;
      }
    }

    if (result.truncated) {
      truncated = true;
    }

    // Separate ancestor messages from target session's own messages
    if (isLast) {
      // Target session's own messages go to targetMessages (no transforms applied)
      targetMessages = result.messages;
    } else {
      // Ancestor messages - add up to fork point
      for (const message of result.messages) {
        ancestorMessages.push(message);

        // Stop after fork point message for ancestors
        if (nextForkPoint && message.messageId === nextForkPoint) {
          break;
        }
      }
    }
  }

  // Apply transforms to ancestor messages only (not target's own messages)
  if (targetTransforms) {
    ancestorMessages = await applyForkTransforms(ancestorMessages, targetTransforms);
  }

  // Combine: transformed ancestors + target's own messages
  const allMessages = [...ancestorMessages, ...targetMessages];

  return {
    messages: allMessages,
    hasSquashBoundary,
    sessionChain,
    truncated,
    incomplete,
  };
}

/**
 * Apply fork transforms to ancestor messages.
 *
 * When `transforms.segments` is present, segment-based execution takes
 * precedence and the legacy `removedMessageIds`/`appliedPipeline` fields
 * are ignored.
 * @param messages - Ancestor messages to transform
 * @param transforms - Transform configuration from fork session
 * @returns Transformed messages
 */
async function applyForkTransforms(messages: SessionMessage[], transforms: ForkTransforms): Promise<SessionMessage[]> {
  // Segment path takes precedence over the legacy fields
  if (transforms.segments?.length) {
    // Segments are defined against the source session range, not necessarily the
    // entire inherited ancestor chain. Preserve untouched prefix/suffix context.
    const firstBoundaryId = transforms.segments[0].fromMessageId;
    const lastBoundaryId = transforms.segments[transforms.segments.length - 1].toMessageId;
    const firstBoundaryIndex = messages.findIndex((message) => message.messageId === firstBoundaryId);
    const lastBoundaryIndex = messages.findIndex((message) => message.messageId === lastBoundaryId);

    // Deliberate partial-tolerance fallback: if firstBoundaryIndex/lastBoundaryIndex
    // cannot define a valid outer range, still run applySegmentTransforms(messages, transforms.segments)
    // so per-segment boundary resolution can continue best-effort with warnings.
    if (firstBoundaryIndex === -1 || lastBoundaryIndex === -1 || firstBoundaryIndex > lastBoundaryIndex) {
      return applySegmentTransforms(messages, transforms.segments);
    }

    const prefix = messages.slice(0, firstBoundaryIndex);
    const segmentScope = messages.slice(firstBoundaryIndex, lastBoundaryIndex + 1);
    const suffix = messages.slice(lastBoundaryIndex + 1);
    const transformedScope = applySegmentTransforms(segmentScope, transforms.segments);
    return [...prefix, ...transformedScope, ...suffix];
  }

  let result = messages;

  // 1. Filter removed messages
  if (transforms.removedMessageIds?.length) {
    const removedSet = new Set(transforms.removedMessageIds);
    result = result.filter((m) => !removedSet.has(m.messageId));
  }

  // 2. Apply pipeline transforms
  if (transforms.appliedPipeline?.length) {
    const pipelineResult = await executePipeline(result, transforms.appliedPipeline);
    result = pipelineResult.messages;
  }

  return result;
}

/**
 * Apply strip flags to a slice of messages belonging to a single segment.
 *
 * Delegates to the canonical pure transform functions exported from the
 * strip-reasoning and strip-tool-outputs session editor actions.
 * @param messages - Messages to strip
 * @param segment - Segment whose strip flags to apply
 * @returns Messages with strip flags applied
 */
function applyStripFlags(messages: SessionMessage[], segment: SegmentPolicy): SessionMessage[] {
  let result = messages;
  if (segment.stripReasoning) {
    result = stripReasoningBlocks(result);
  }
  if (segment.stripToolOutputs) {
    result = stripToolOutputBlocks(result);
  }
  return result;
}

/**
 * Execute segment-based context projection for ancestor messages.
 *
 * Algorithm:
 * 1. Build a message-ID-to-index map for O(1) range lookup.
 * 2. For each segment, slice the inclusive message range.
 * 3. Apply the segment policy (exclude / summarize / verbatim).
 * 4. Apply per-message overrides (`exclude` removes individual messages).
 * 5. Apply strip flags (stripReasoning, stripToolOutputs) independently.
 * 6. Concatenate all processed segments and return.
 *
 * Exported for direct testability without going through the bus layer.
 * @param messages - Full ancestor message array
 * @param segments - Ordered segment policy definitions
 * @returns Projected messages after all segment policies are applied
 */
export function applySegmentTransforms(messages: SessionMessage[], segments: SegmentPolicy[]): SessionMessage[] {
  // Build index map once for O(1) range lookups
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    idToIndex.set(messages[i].messageId, i);
  }

  const output: SessionMessage[] = [];

  for (const segment of segments) {
    const fromIndex = idToIndex.get(segment.fromMessageId);
    const toIndex = idToIndex.get(segment.toMessageId);

    // Keep partial-tolerance behavior, but surface boundary mismatches for diagnosis.
    if (fromIndex === undefined || toIndex === undefined) {
      console.warn('[getFullConversation] Skipping segment with missing boundary IDs', {
        segmentKey: `${segment.fromMessageId}..${segment.toMessageId}`,
        fromMessageId: segment.fromMessageId,
        toMessageId: segment.toMessageId,
        hasFrom: fromIndex !== undefined,
        hasTo: toIndex !== undefined,
      });
      continue;
    }

    const slice = messages.slice(fromIndex, toIndex + 1);

    // Apply policy
    let processed: SessionMessage[];

    switch (segment.policy) {
      case 'exclude':
        processed = [];
        break;

      case 'summarize':
        if (segment.summaryText) {
          if (slice.length === 0) {
            throw new Error(
              `Cannot create synthetic summary message for empty segment: ${segment.fromMessageId}..${segment.toMessageId}`,
            );
          }
          // Replace the entire range with a single synthetic summary message
          const syntheticId = `summary-${segment.fromMessageId}-${segment.toMessageId}`;
          const synthetic: SessionMessage = {
            messageId: syntheticId,
            turnId: null,
            // Session ID must come from the represented range, not from a fallback literal.
            sessionId: slice[0].sessionId,
            role: 'assistant',
            contentText: segment.summaryText,
            blocks: [{ type: 'text', content: segment.summaryText }],
            // Use represented message time to keep context projection deterministic.
            timestamp: slice[slice.length - 1].timestamp,
          };
          processed = [synthetic];
        } else {
          // summaryText not yet generated (preview-pending state) — fall back to verbatim
          processed = slice;
        }
        break;

      case 'verbatim':
      default:
        processed = slice;
        break;
    }

    // Apply per-message overrides only when the current projection still uses raw message IDs.
    // A synthesized summary message is segment-level output and is not targetable via per-message overrides.
    const shouldApplyMessageOverrides = segment.policy !== 'summarize' || !segment.summaryText;
    if (shouldApplyMessageOverrides && segment.overrides && Object.keys(segment.overrides).length > 0) {
      const excludedIds = new Set(
        Object.entries(segment.overrides)
          .filter(([, action]) => action === 'exclude')
          .map(([id]) => id),
      );
      processed = processed.filter((msg) => !excludedIds.has(msg.messageId));
    }

    // Apply strip flags (skip for exclude policy — processed is already empty)
    processed = applyStripFlags(processed, segment);

    output.push(...processed);
  }

  return output;
}
