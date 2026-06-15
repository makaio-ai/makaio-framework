/**
 * Handler for session.fork RPC.
 *
 * Creates a new session that references the parent via parentSessionId
 * and forkPointMessageId. NO message copying occurs - full conversation
 * is assembled via getFullConversation() traversal.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type ForkTransforms } from '@makaio/contracts';
import { MessageStorageSubjects, type MessagePageCursor } from '../messages/namespace.js';
import { actionRegistry } from '../session-editor/action-registry.js';

const MESSAGE_PAGE_LIMIT = 200;

/**
 * Validate segment transforms against source-session message ordering.
 * Segments must be contiguous, ordered, and fully cover the source message list.
 * @param bus - Bus for reading source messages
 * @param sourceSessionId - Session whose messages define valid segment boundaries
 * @param transforms - Fork transforms to validate
 * @param forkPointMessageId - Optional fork point; validation scope ends at this message when provided
 * @returns True when segment transforms were present and valid, otherwise false
 * @throws Error when segment boundaries are invalid or non-contiguous
 */
async function validateSegments(
  bus: IMakaioBus,
  sourceSessionId: string,
  transforms: ForkTransforms,
  forkPointMessageId?: string,
): Promise<boolean> {
  if (!transforms.segments?.length) {
    return false;
  }

  const messages = [];
  let cursor: MessagePageCursor | undefined;

  do {
    const { messages: page, nextCursor } = await bus.request(MessageStorageSubjects.getBySession, {
      sessionId: sourceSessionId,
      order: 'asc',
      limit: MESSAGE_PAGE_LIMIT,
      after: cursor,
    });
    messages.push(...page);
    if (forkPointMessageId && page.some((message) => message.messageId === forkPointMessageId)) {
      cursor = undefined;
    } else {
      cursor = nextCursor ?? undefined;
    }
  } while (cursor);

  if (messages.length === 0) {
    throw new Error(
      `[fork-handler] Segment transforms require at least one source message (sourceSessionId=${sourceSessionId})`,
    );
  }

  let validatedMessages = messages;
  if (forkPointMessageId) {
    const forkPointIndex = messages.findIndex((message) => message.messageId === forkPointMessageId);
    if (forkPointIndex === -1) {
      throw new Error(
        `[fork-handler] Fork point message not found in source message list: ${forkPointMessageId} (sourceSessionId=${sourceSessionId})`,
      );
    }
    // Segment transforms apply only to inherited ancestor context up to fork point (inclusive).
    validatedMessages = messages.slice(0, forkPointIndex + 1);
  }

  const idToIndex = new Map<string, number>();
  validatedMessages.forEach((message, index) => {
    idToIndex.set(message.messageId, index);
  });

  let previousEndIndex = -1;
  for (const segment of transforms.segments) {
    if (!segment.fromMessageId || !segment.toMessageId) {
      throw new Error(
        `[fork-handler] Segment must have fromMessageId and toMessageId (sourceSessionId=${sourceSessionId})`,
      );
    }

    const startIndex = idToIndex.get(segment.fromMessageId);
    const endIndex = idToIndex.get(segment.toMessageId);

    if (startIndex === undefined || endIndex === undefined) {
      throw new Error(
        `[fork-handler] Segment boundaries must reference source messages: ${segment.fromMessageId}..${segment.toMessageId} (sourceSessionId=${sourceSessionId})`,
      );
    }

    if (startIndex > endIndex) {
      throw new Error(
        `[fork-handler] Segment range is reversed: ${segment.fromMessageId}..${segment.toMessageId} (sourceSessionId=${sourceSessionId})`,
      );
    }

    if (startIndex <= previousEndIndex) {
      throw new Error(
        `[fork-handler] Segments must not overlap and must be ordered (sourceSessionId=${sourceSessionId})`,
      );
    }

    if (startIndex !== previousEndIndex + 1) {
      throw new Error(`[fork-handler] Segments must be contiguous without gaps (sourceSessionId=${sourceSessionId})`);
    }

    previousEndIndex = endIndex;
  }

  if (previousEndIndex !== validatedMessages.length - 1) {
    throw new Error(
      `[fork-handler] Segments must cover the entire source message range (sourceSessionId=${sourceSessionId})`,
    );
  }

  return true;
}

/**
 * Validate that all pipeline actions in transforms exist and are transformation category.
 * Segment validation takes precedence when `segments` is present.
 * @param transforms - Fork transforms to validate
 * @throws Error if any segment is structurally invalid or any pipeline action is unknown/non-transformation
 */
function validatePipelineTransforms(transforms: ForkTransforms): void {
  if (transforms.segments?.length) {
    return;
  }

  if (!transforms.appliedPipeline?.length) {
    return;
  }

  for (const step of transforms.appliedPipeline) {
    const action = actionRegistry.get(step.actionId);

    if (!action) {
      throw new Error(`[fork-handler] Unknown action in pipeline: ${step.actionId}`);
    }

    if (action.category !== 'transformation') {
      throw new Error(
        `[fork-handler] Action '${step.actionId}' is category '${action.category}', ` +
          `but only 'transformation' actions are allowed in fork transforms`,
      );
    }
  }
}

/**
 * Registers the session.fork RPC handler.
 *
 * Creates a new session with parent reference. The forked session starts
 * empty - its full conversation is assembled by traversing the parent chain.
 * @param bus - Bus instance for communication
 * @returns Cleanup function to unsubscribe
 */
export function registerForkHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.fork, async (ctx) => {
    const {
      sourceSessionId,
      fromMessageId,
      name,
      branchKind = 'fork',
      transforms,
      targetWorkingDirectory,
      metadata,
      existingSessionId,
    } = ctx.payload;

    // 1. Validate source session exists
    const { session: sourceSession } = await bus.request(SessionSubjects.get, {
      sessionId: sourceSessionId,
    });

    if (!sourceSession) {
      throw new Error(`[fork-handler] Source session not found: ${sourceSessionId}`);
    }

    // 2. Validate fromMessageId exists and belongs to source session
    if (fromMessageId) {
      const { message } = await bus.request(MessageStorageSubjects.get, {
        messageId: fromMessageId,
      });

      if (!message) {
        throw new Error(
          `[fork-handler] Fork point message not found: ${fromMessageId} (sourceSessionId=${sourceSessionId})`,
        );
      }

      if (message.sessionId !== sourceSessionId) {
        throw new Error(
          `[fork-handler] Fork point message ${fromMessageId} does not belong to session ${sourceSessionId}`,
        );
      }
    }

    // 3. Validate transforms if provided
    if (transforms) {
      const hasSegments = await validateSegments(bus, sourceSessionId, transforms, fromMessageId);
      if (!hasSegments) {
        validatePipelineTransforms(transforms);
      }
    }

    // 4. Create new session with parent reference (NO message copying)
    // existingSessionId is injected by host interceptors (e.g. fork scope interceptor)
    // so the child session ID is known before the junction table row is written,
    // achieving a zero-timing-gap guarantee.
    const { sessionId: newSessionId } = await bus.request(SessionSubjects.create, {
      ...(existingSessionId ? { sessionId: existingSessionId } : {}),
      parentSessionId: sourceSessionId,
      forkPointMessageId: fromMessageId,
      branchKind,
      forkTransforms: transforms,
      ...(name ? { title: name } : {}),
      ...(targetWorkingDirectory ? { targetWorkingDirectory } : {}),
      ...(metadata ? { metadata } : {}),
    });

    // 5. Emit branch.created event (includes transforms for audit trail)
    await bus.emit(SessionSubjects.branch.created, {
      sessionId: sourceSessionId, // Event belongs to parent session
      childSessionId: newSessionId,
      parentSessionId: sourceSessionId,
      kind: branchKind,
      forkPointMessageId: fromMessageId,
      transforms,
    });

    // 6. Emit forked lifecycle event
    await bus.emit(SessionSubjects.forked, {
      parentSessionId: sourceSessionId,
      childSessionId: newSessionId,
      forkPoint: fromMessageId,
    });

    ctx.setResult({
      sessionId: newSessionId,
    });
  });
}
