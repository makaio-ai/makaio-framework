/**
 * Turn and thread flow handlers for the Codex App-Server connector.
 *
 * Handles thread startup (`startThread`), turn dispatch (`startTurn`),
 * queue draining (`processQueue`), and the `thread/started` /
 * `turn/completed` notification callbacks (`onThreadStarted`, `onTurnCompleted`).
 *
 * All mutable connector state is accessed through the typed accessors in
 * {@link TurnFlowContext} so this module never holds stale references.
 * @packageDocumentation
 */

import type { ProcessingState, MessageHandle, MessageResult } from '@makaio/ai-adapters-core';
import { UserMessageQueue, markCompletedWithFinalResult } from '@makaio/ai-adapters-core';
import type {
  ThreadForkResponse,
  ThreadResumeResponse,
  ThreadStartedNotification,
  ThreadStartResponse,
  TurnCompletedNotification,
} from '../protocol/generated/v2/index.js';
import { CodexAppServerSubjects, type CodexAppServerBus } from '../namespaces/index.js';
import { CodexAppServerThread } from '../thread.js';
import { CodexAppServerTurn } from '../turn.js';
import { buildUserInputs } from '../utils/buildUserInputs.js';
import { extractThreadId } from './lifecycle-handlers.js';
import { fetchToolsForCodex, type ThreadStartParamsWithDynamicTools } from '../dynamic-tool-handling.js';
import type { JsonRpcClient } from '../utils/jsonRpcClient.js';
import type { ApprovalPolicy, SandboxMode, ReasoningEffort } from './types.js';
import type { ReasoningEffort as CodexReasoningEffort } from '../protocol/generated/ReasoningEffort.js';
import type { AIReasoningLevel, NativeForkDirective } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';

type ThreadLifecycleResponse = ThreadForkResponse | ThreadResumeResponse | ThreadStartResponse;

interface ThreadStartedDeferred {
  promise: Promise<string>;
  resolve: (id: string) => void;
}

/**
 * Maps canonical {@link AIReasoningLevel} values to Codex protocol {@link CodexReasoningEffort} strings.
 * @param level - Canonical reasoning level (must not be `'none'`)
 * @returns Codex-native effort string
 */
function mapToCodexEffort(level: Exclude<AIReasoningLevel, 'none'>): CodexReasoningEffort {
  return level === 'extra-high' ? 'xhigh' : level;
}

/**
 * Mutable connector state and callbacks required by the turn flow handlers.
 */
export interface TurnFlowContext {
  /** Returns the current turn, or `undefined` when idle. */
  getCurrentTurn: () => CodexAppServerTurn | undefined;
  /** Replaces (or clears) the active turn. */
  setCurrentTurn: (turn: CodexAppServerTurn | undefined) => void;
  /** Returns the active thread, or `undefined` before thread startup completes. */
  getThread: () => CodexAppServerThread | undefined;
  /** Replaces (or clears) the active thread. */
  setThread: (thread: CodexAppServerThread | undefined) => void;
  /** Returns the `agentMessageContent` accumulator. */
  getAgentMessageContent: () => string;
  /** Replaces the `agentMessageContent` accumulator. */
  setAgentMessageContent: (content: string) => void;
  /** Returns the pending message handle awaiting turn completion. */
  getPendingMessageHandle: () => MessageHandle | undefined;
  /** Replaces (or clears) the pending message handle. */
  setPendingMessageHandle: (handle: MessageHandle | undefined) => void;
  /** Stores the most-recent turn result for `complete()` / queue drain decisions. */
  setLastResult: (result: MessageResult) => void;
  /** Returns the most-recent turn result, or `null` if no turn has completed. */
  getLastResult: () => MessageResult | null;
  /** Sets the adapter session ID once the thread ID is known. */
  setAdapterSessionId: (id: string) => void;
  /**
   * Holds the deferred promise created in `startThread` so `getAdapterSessionId()`
   * can await it when called before the thread ID is registered.
   */
  getThreadStartedDeferred: () => ThreadStartedDeferred | undefined;
  /** Replaces (or clears) the deferred thread-started promise. */
  setThreadStartedDeferred: (deferred: ThreadStartedDeferred | undefined) => void;
  /** Message queue shared with the connector's `sendMessage` path. */
  messageQueue: UserMessageQueue;
  /** The JSON-RPC client, guaranteed non-null when turn flow methods are called. */
  getJsonRpcClient: () => JsonRpcClient;
  /** Scoped bus for event emission. */
  emit: CodexAppServerBus['emit'];
  /** Updates the connector's processing state. */
  updateProcessingState: (state: ProcessingState) => Promise<void>;
  /** Agent ID for turn and thread construction. */
  agentId: string;
  /** Adapter ID for turn and thread construction. */
  adapterId: string;
  /** Adapter name for tool fetching. */
  adapterName: string;
  /** Scoped bus for thread and turn construction. */
  bus: CodexAppServerBus;
  /** Global bus for registry tool loading and execution. */
  globalBus: IMakaioBus;
  /** Current model identifier, read at turn-start time. */
  getModel: () => string;
  /** Current reasoning effort level, read at turn-start time. */
  getReasoningEffort: () => ReasoningEffort | undefined;
  /** Current approval policy, read at thread-start time. */
  getApprovalPolicy: () => ApprovalPolicy | undefined;
  /** Current sandbox mode, read at thread-start time. */
  getSandboxMode: () => SandboxMode | undefined;
  /** Resolved system prompt text, or `null` when absent. */
  resolveSystemPrompt: () => string | null;
  /** Working directory passed to `thread/start`. */
  cwd: string;
  /** Runtime allowlist for registry tools. Empty array intentionally disables all registry tools. */
  allowedTools?: readonly string[];
  /** Runtime denylist for registry tools. Takes precedence over allowedTools. */
  disallowedTools?: readonly string[];
  /**
   * Previous adapter session ID for native resume.
   *
   * When set, `startThread` sends `thread/resume` instead of `thread/start`.
   * Ignored when {@link nativeFork} is also set.
   */
  resumeAdapterSessionId?: string;
  /**
   * Native fork directive from the session orchestrator.
   *
   * When set without `forkPointMessageId`, `startThread` sends `thread/fork`
   * instead of `thread/start`. Codex app-server supports only tip forks; a
   * directive with `forkPointMessageId` is rejected before `thread/fork`.
   * Takes precedence over {@link resumeAdapterSessionId}.
   *
   * One-shot invariant: the Codex connector enforces one-shot consumption
   * structurally — `startThread` is guarded by `if (!this.thread)` in the
   * connector, so it runs at most once per connector lifetime. Unlike the
   * CLI and SDK adapters (which consume the directive by clearing
   * `config.nativeFork` after `system.init`), Codex relies on the thread
   * guard because the JSON-RPC thread is a persistent connection, not a
   * per-turn subprocess.
   */
  nativeFork?: NativeForkDirective;
}

/**
 * Creates the deferred used by callers waiting for a provider thread ID during startup.
 * @returns Deferred promise and resolver for the thread ID
 */
function createThreadStartedDeferred(): ThreadStartedDeferred {
  let resolveThreadStarted: (id: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    resolveThreadStarted = resolve;
  });

  return { promise, resolve: resolveThreadStarted };
}

/**
 * Extracts the provider thread ID from a thread lifecycle JSON-RPC response.
 * @param response - Response from `thread/start`, `thread/resume`, or `thread/fork`
 * @returns Provider thread ID
 */
function extractResponseThreadId(response: ThreadLifecycleResponse): string {
  const threadId = response.thread?.id;
  if (!threadId) {
    throw new Error('Codex app-server thread lifecycle response is missing thread.id');
  }
  return threadId;
}

/**
 * Register a thread ID from either the JSON-RPC response or the later notification.
 * @param ctx - Turn flow context
 * @param threadId - Provider thread ID to register
 */
async function registerThreadStarted(ctx: TurnFlowContext, threadId: string): Promise<void> {
  const existingThread = ctx.getThread();
  if (existingThread?.threadId !== undefined) {
    if (existingThread.threadId === threadId) {
      ctx.setAdapterSessionId(threadId);
      ctx.getThreadStartedDeferred()?.resolve(threadId);
      return;
    }
    throw new Error(
      `Codex app-server thread ID mismatch: active thread is ${existingThread.threadId}, received ${threadId}`,
    );
  }

  ctx.setAdapterSessionId(threadId);
  ctx.getThreadStartedDeferred()?.resolve(threadId);

  const thread =
    existingThread ??
    new CodexAppServerThread({
      bus: ctx.bus,
      adapterId: ctx.adapterId,
      agentId: ctx.agentId,
    });
  ctx.setThread(thread);

  await thread.handleThreadStarted(threadId);
}

/**
 * Rejects native fork directives that Codex app-server cannot represent safely.
 * @param nativeFork - Native fork directive to validate
 */
function assertSupportedNativeFork(nativeFork: NativeForkDirective): void {
  if (nativeFork.forkPointMessageId === undefined) return;

  throw new Error(
    `Codex app-server native fork only supports tip forks; forkPointMessageId ${nativeFork.forkPointMessageId} ` +
      `cannot be sent to thread/fork for source thread ${nativeFork.sourceAdapterSessionId}`,
  );
}

/**
 * Launch the appropriate ACP thread-start request, await the corresponding
 * JSON-RPC response, and populate the connector's `adapterSessionId`.
 *
 * Method selection (highest precedence first):
 * - `nativeFork` present without `forkPointMessageId` → `thread/fork`
 * - `resumeAdapterSessionId` present → `thread/resume` (continue existing thread)
 * - Otherwise → `thread/start` (create a new thread)
 *
 * Only the stable `threadId` parameter is used for resume and fork — the
 * `path` and `history` params are explicitly avoided as they are unstable.
 *
 * A deferred promise is created before the request so `getAdapterSessionId()`
 * can wait while the request is in flight. The JSON-RPC response is authoritative
 * for startup completion; a later matching `thread/started` notification is an
 * idempotent confirmation.
 * On error the deferred is cleared to prevent `getAdapterSessionId()` from hanging.
 * @param ctx - Turn flow context
 */
export async function startThread(ctx: TurnFlowContext): Promise<void> {
  ctx.setThreadStartedDeferred(createThreadStartedDeferred());

  try {
    let response: ThreadLifecycleResponse;
    if (ctx.nativeFork !== undefined) {
      assertSupportedNativeFork(ctx.nativeFork);
      response = await ctx.getJsonRpcClient().request<ThreadForkResponse>('thread/fork', {
        threadId: ctx.nativeFork.sourceAdapterSessionId,
        ...(ctx.nativeFork.targetWorkingDirectory !== undefined && { cwd: ctx.nativeFork.targetWorkingDirectory }),
      });
    } else if (ctx.resumeAdapterSessionId !== undefined) {
      const cwd = ctx.cwd;
      response = await ctx.getJsonRpcClient().request<ThreadResumeResponse>('thread/resume', {
        threadId: ctx.resumeAdapterSessionId,
        ...(cwd !== undefined && { cwd }),
      });
    } else {
      const dynamicTools = await fetchToolsForCodex(ctx.globalBus, ctx.adapterId, ctx.adapterName, {
        allowedTools: ctx.allowedTools,
        disallowedTools: ctx.disallowedTools,
      });

      const threadStartParams: ThreadStartParamsWithDynamicTools = {
        model: ctx.getModel() ?? null,
        modelProvider: null,
        cwd: ctx.cwd ?? null,
        approvalPolicy: ctx.getApprovalPolicy() ?? null,
        sandbox: ctx.getSandboxMode() ?? null,
        config: null,
        baseInstructions: ctx.resolveSystemPrompt(),
        developerInstructions: null,
        experimentalRawEvents: false,
        dynamicTools: dynamicTools.length > 0 ? dynamicTools : undefined,
      };

      response = await ctx.getJsonRpcClient().request<ThreadStartResponse>('thread/start', threadStartParams);
    }

    await registerThreadStarted(ctx, extractResponseThreadId(response));
    ctx.setThreadStartedDeferred(undefined);
  } catch (error) {
    // Clear deferred so getAdapterSessionId() throws rather than awaiting a hung promise.
    // Failed native resume/fork attempts intentionally rethrow without a local
    // fallback: degrading to fresh-with-history is an orchestration decision
    // (session routing retries once with injected history), and the adapter
    // must not silently change fork semantics on its own.
    ctx.setThreadStartedDeferred(undefined);
    throw error;
  }
}

/**
 * Send a single `turn/start` request and wire the active turn.
 *
 * Creates a new {@link CodexAppServerTurn}, assigns it as the active turn, resets
 * the message accumulator, and fires the ACP `turn/start` request with the
 * current model and reasoning effort.
 * @param ctx - Turn flow context
 * @param messageHandle - Handle for the message being dispatched
 * @param mergedContent - Optional content lines merged from superseded handles
 */
export async function startTurn(
  ctx: TurnFlowContext,
  messageHandle: MessageHandle,
  mergedContent?: string[],
): Promise<void> {
  const thread = ctx.getThread();
  if (!thread?.threadId) throw new Error('Cannot start turn: thread not started');

  ctx.setCurrentTurn(
    new CodexAppServerTurn(ctx.bus, ctx.adapterId, ctx.adapterName, ctx.agentId, thread.threadId, messageHandle),
  );

  ctx.setPendingMessageHandle(messageHandle);
  ctx.setAgentMessageContent('');

  await ctx.getCurrentTurn()!.start();
  const userInputs = buildUserInputs(messageHandle, mergedContent);
  const effort = ctx.getReasoningEffort();
  await ctx.getJsonRpcClient().request('turn/start', {
    threadId: thread.threadId,
    input: userInputs,
    cwd: null,
    approvalPolicy: null,
    sandboxPolicy: null,
    model: ctx.getModel() ?? null,
    effort: effort !== undefined && effort !== 'none' ? mapToCodexEffort(effort) : null,
    summary: null,
    outputSchema: messageHandle.responseSchema?.schema ?? null,
  });
}

/**
 * Drain the message queue, dispatching the next eligible message as a new turn.
 *
 * Late-arriving `immediate` messages (arriving after a turn has already completed)
 * are rejected and the queue is re-drained to unblock any remaining entries.
 * @param ctx - Turn flow context
 */
export async function processQueue(ctx: TurnFlowContext): Promise<void> {
  if (ctx.getCurrentTurn() && !ctx.getCurrentTurn()!.isCompleted()) return;

  const nextMessage = ctx.messageQueue.peek();
  if (!nextMessage) return;

  // Late-rejection: an immediate that arrives after a turn completed missed the
  // active-turn window for context injection. Reject it and drain remaining
  // enqueued messages. Mirrors processQueueMessages() in adapters-core.
  // Uses lastResult to distinguish "post-turn idle" from "fresh agent with no prior turn."
  if (nextMessage.deliveryMode === 'immediate' && ctx.getLastResult() !== null) {
    ctx.messageQueue.dequeue();
    nextMessage.markCompleted({ outcome: 'rejected' });
    // Drain remaining queued messages (more late immediates), then transition
    // to idle if no turn was started. Without this, sendMessage() leaves the
    // connector in 'active' state and complete() waits forever.
    await processQueue(ctx);
    if (!ctx.getCurrentTurn() && ctx.messageQueue.isEmpty()) {
      await ctx.updateProcessingState('idle');
    }
    return;
  }

  const message = ctx.messageQueue.dequeue();
  if (!message) return;

  await startTurn(ctx, message);

  if (!ctx.messageQueue.isEmpty()) await processQueue(ctx);
}

/**
 * Handle the `thread/started` notification from the Codex server.
 *
 * Resolves the deferred thread-started promise, sets the adapter session ID,
 * creates and registers the {@link CodexAppServerThread}, and fires the thread
 * lifecycle handler.
 * @param ctx - Turn flow context
 * @param notification - Parsed notification payload
 */
export async function onThreadStarted(ctx: TurnFlowContext, notification: ThreadStartedNotification): Promise<void> {
  const threadId = extractThreadId(notification);

  await registerThreadStarted(ctx, threadId);
}

/**
 * Handle the `turn/completed` notification from the Codex server.
 *
 * Manages the superseded-message / merged-message fast path (when an `immediate`
 * message is waiting), then settles the pending handle with its outcome. Drains
 * the queue or transitions to idle when no further messages are queued.
 * @param ctx - Turn flow context
 * @param _notification - Parsed notification payload (currently unused)
 */
export async function onTurnCompleted(ctx: TurnFlowContext, _notification: TurnCompletedNotification): Promise<void> {
  if (!ctx.getCurrentTurn()) return;

  await ctx.getCurrentTurn()!.handleTurnCompleted();

  const immediateMsg = ctx.messageQueue.findImmediate();
  if (immediateMsg && ctx.getPendingMessageHandle()) {
    ctx.messageQueue.removeImmediate(immediateMsg);

    const mergedContent: string[] = [];
    const currentHandle = ctx.getPendingMessageHandle()!;
    if (currentHandle.message.message) {
      mergedContent.push(currentHandle.message.message);
    }

    currentHandle.supersededBy = immediateMsg.messageId;
    currentHandle.markCompleted({ outcome: 'superseded', supersededBy: immediateMsg.messageId });

    const enqueuedHandles = ctx.messageQueue.drainEnqueued();
    for (const handle of enqueuedHandles) {
      if (handle.message.message) mergedContent.push(handle.message.message);
      handle.supersededBy = immediateMsg.messageId;
      handle.markCompleted({ outcome: 'merged', mergedInto: immediateMsg.messageId });
    }

    ctx.setLastResult({ outcome: 'superseded', supersededBy: immediateMsg.messageId });
    ctx.setPendingMessageHandle(undefined);
    ctx.setCurrentTurn(undefined);

    await ctx.updateProcessingState('turn_finished');
    await ctx.updateProcessingState('processing_finished');
    await startTurn(ctx, immediateMsg, mergedContent);
    return;
  }

  const pendingHandle = ctx.getPendingMessageHandle();
  if (pendingHandle) {
    // Emit the final agent_message before markCompleted so SessionBridge
    // accumulates blocks before agent.complete fires.
    const turnId = ctx.getCurrentTurn()?.getTurnId();
    const threadId = ctx.getThread()?.threadId;
    const agentMessageContent = ctx.getAgentMessageContent();
    if (agentMessageContent && threadId && turnId) {
      await ctx.emit(CodexAppServerSubjects.agent_message, {
        threadId,
        turnId,
        message: agentMessageContent,
        timestamp: Date.now(),
      });
    }
    const result: MessageResult = {
      outcome: 'completed',
      result: { message: agentMessageContent || '(Empty response)' },
    };
    await markCompletedWithFinalResult(pendingHandle, result, (_handle, finalResult) => {
      ctx.setLastResult(finalResult);
    });
    ctx.setPendingMessageHandle(undefined);
  }

  ctx.setCurrentTurn(undefined);

  await ctx.updateProcessingState('turn_finished');
  await ctx.updateProcessingState('processing_finished');

  if (!ctx.messageQueue.isEmpty()) {
    await processQueue(ctx);
  } else {
    await ctx.updateProcessingState('idle');
  }
}
