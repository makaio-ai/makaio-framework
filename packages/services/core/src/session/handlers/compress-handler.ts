/**
 * Handler for session.compress RPC.
 *
 * Executes a pipeline on session messages and inserts a squash event.
 * The squash event marks a context boundary - messages before it
 * are summarized by the context JSON.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { executePipeline } from '../session-editor/pipeline-executor.js';
import { registerBuiltInActions } from '../session-editor/actions/index.js';

/**
 * Registers the session.compress RPC handler.
 *
 * Executes a pipeline on session messages and inserts a squash event.
 * The squash event marks a context boundary - messages before it
 * are summarized by the context JSON.
 * @param bus - Bus instance
 * @returns Cleanup function
 */
export function registerCompressHandler(bus: IMakaioBus): () => void {
  // Compression pipelines rely on built-in action IDs (e.g. strip-tool-outputs).
  // Keep this invariant local to the handler so callers do not manage editor internals.
  // Passing bus enables bus-dependent actions (e.g. llm-extract).
  registerBuiltInActions(bus);

  return bus.on(SessionSubjects.compress, async (ctx) => {
    const { sessionId, pipeline } = ctx.payload;

    // 1. Load all messages from session
    const { messages } = await bus.request(MessageStorageSubjects.getBySession, {
      sessionId,
      limit: 10000,
    });

    // 2. Execute pipeline (sessionId is injected into each step's options so
    //    bus-dependent actions like llm-extract can use it for resolution context)
    const result = await executePipeline(messages, pipeline, { sessionId });

    if (!result.contextJson) {
      throw new Error(`[compress-handler] Compress pipeline must produce context JSON (sessionId=${sessionId})`);
    }

    // 3. Get message IDs for audit
    const compressedMessageIds = messages.map((m) => m.messageId);

    // 4. Compute token estimate (rough: 4 chars per token)
    const tokensBefore = Math.ceil(messages.reduce((sum, m) => sum + JSON.stringify(m.blocks).length / 4, 0));

    // 5. Insert squash event
    const eventId = crypto.randomUUID();
    await bus.request(SessionEventStorageSubjects.append, {
      event: {
        sessionId,
        eventId,
        timestamp: Date.now(),
        type: 'squash',
        payload: {
          summaryJson: JSON.stringify(result.contextJson),
          tokensBefore,
          tokensAfter: result.tokenEstimate,
          compressedMessageIds,
        },
      },
    });

    // 6. Emit compressed event (for ContextWindowTracker and other listeners)
    await bus.emit(SessionSubjects.compressed, { sessionId, eventId });

    ctx.setResult({
      eventId,
      contextJson: result.contextJson,
      tokensBefore,
      tokensAfter: result.tokenEstimate,
    });
  });
}
