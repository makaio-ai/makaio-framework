/**
 * Lifecycle event handlers for Codex App-Server.
 *
 * Handles thread, turn, and item lifecycle notifications.
 * @packageDocumentation
 */

import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadStartedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnStartedNotification,
} from '../protocol/generated/v2/index.js';
import type { ProcessingState } from '@makaio/ai-adapters-core';
import { CodexAppServerSubjects, type CodexAppServerBus } from '../namespaces/index.js';
import type { CodexAppServerThread } from '../thread.js';
import type { CodexAppServerTurn, ItemType } from '../turn.js';
import type { DynamicToolCallCacheEntry } from '../dynamic-tool-handling.js';

/**
 * Emit function type for bus events.
 */
type EmitFn = CodexAppServerBus['emit'];

/**
 * Extract thread ID from thread/started notification.
 * @param notification - Thread started notification
 * @returns Thread ID string
 */
export function extractThreadId(notification: ThreadStartedNotification): string {
  return notification.thread.id;
}

/**
 * Handle turn/started notification.
 * Acknowledges the message when the turn starts (server echoed it).
 * @param notification - Turn started notification
 * @param turn - Current turn instance
 * @param updateProcessingState - State update callback
 */
export async function handleTurnStarted(
  notification: TurnStartedNotification,
  turn: CodexAppServerTurn | undefined,
  updateProcessingState: (state: ProcessingState) => Promise<void>,
): Promise<void> {
  if (!turn) {
    console.warn('[CodexAppServerConnector] Received turn/started but no current turn');
    return;
  }

  turn.markAcknowledged();
  await turn.handleTurnStarted(notification.turn.id);
  await updateProcessingState('processing_started');
  await updateProcessingState('turn_started');
}

/**
 * Handle item/started notification.
 * @param notification - Item started notification
 * @param turn - Current turn instance
 * @param emit - Bus emit function
 * @param commandCache - Cache for command execution metadata
 * @param dynamicToolCallCache - Cache for dynamic tool call metadata and results
 * @param updateProcessingState - State update callback
 * @param onCommandInfoReady - Optional callback invoked after a commandExecution entry
 *   is written to `commandCache`. Used to unblock approval requests that arrived before
 *   this `item/started` notification.
 */
export async function handleItemStarted(
  notification: ItemStartedNotification,
  turn: CodexAppServerTurn | undefined,
  emit: EmitFn,
  commandCache: Map<string, { command: string; cwd: string }>,
  dynamicToolCallCache: Map<string, DynamicToolCallCacheEntry>,
  updateProcessingState: (state: ProcessingState) => Promise<void>,
  onCommandInfoReady?: (itemId: string, info: { command: string; cwd: string }) => void,
): Promise<void> {
  if (!turn) return;

  const item = notification.item;
  const itemId = 'id' in item ? item.id : '';
  // Cast to ItemType to accept experimental types not yet in the generated `ThreadItem` union
  // (e.g. `dynamicToolCall`). The cast is intentional and safe: the codex server sends the
  // actual type string; we own the `ItemType` definition and keep it in sync.
  const itemType = item.type as ItemType;
  await turn.handleItemStarted(itemId, itemType);
  await updateProcessingState('step_started');

  // Emit exec_command_begin for command execution items
  if (item.type === 'commandExecution') {
    const info = { command: item.command, cwd: item.cwd };
    commandCache.set(item.id, info);
    onCommandInfoReady?.(item.id, info);
    await emit(CodexAppServerSubjects.exec_command_begin, {
      threadId: notification.threadId,
      turnId: notification.turnId,
      callId: item.id,
      command: [item.command],
      cwd: item.cwd,
      timestamp: Date.now(),
    });
  }

  // Emit dynamic_tool_call_begin for dynamic tool call items (experimental API).
  // The cache entry is populated by the item/tool/call server request handler which
  // fires before or concurrent with this notification.
  // Use `itemType` (already cast from `item.type`) to avoid the TypeScript overlap error
  // that arises when comparing `item.type` (the generated union) to a type not in that union.
  if (itemType === 'dynamicToolCall') {
    const cached = dynamicToolCallCache.get(itemId);
    if (cached) {
      await emit(CodexAppServerSubjects.dynamic_tool_call_begin, {
        threadId: notification.threadId,
        turnId: notification.turnId,
        itemId,
        name: cached.name,
        args: cached.args,
        timestamp: Date.now(),
      });
    } else {
      console.warn(`[lifecycle-handlers] dynamicToolCall item ${itemId} started with no cached tool call data`);
    }
  }
}

/**
 * Handle item/completed notification.
 * @param notification - Item completed notification
 * @param turn - Current turn instance
 * @param emit - Bus emit function
 * @param commandCache - Cache for command execution metadata
 * @param dynamicToolCallCache - Cache for dynamic tool call metadata and results
 * @param updateProcessingState - State update callback
 */
export async function handleItemCompleted(
  notification: ItemCompletedNotification,
  turn: CodexAppServerTurn | undefined,
  emit: EmitFn,
  commandCache: Map<string, { command: string; cwd: string }>,
  dynamicToolCallCache: Map<string, DynamicToolCallCacheEntry>,
  updateProcessingState: (state: ProcessingState) => Promise<void>,
): Promise<void> {
  if (!turn) return;

  const item = notification.item;
  const itemId = 'id' in item ? item.id : '';
  // Cast to ItemType to accept experimental types not yet in the generated `ThreadItem` union.
  const itemType = item.type as ItemType;
  await turn.handleItemCompleted(itemId);
  await updateProcessingState('step_finished');

  // Emit exec_command_end for command execution items
  if (item.type === 'commandExecution') {
    await emit(CodexAppServerSubjects.exec_command_end, {
      threadId: notification.threadId,
      turnId: notification.turnId,
      callId: item.id,
      exitCode: item.exitCode ?? 0,
      timestamp: Date.now(),
    });
    commandCache.delete(item.id);
    return;
  }

  // Emit dynamic_tool_call_end for dynamic tool call items (experimental API).
  // Use `itemType` (already cast) to avoid the TypeScript overlap error.
  if (itemType === 'dynamicToolCall') {
    const cached = dynamicToolCallCache.get(itemId);
    if (cached) {
      await emit(CodexAppServerSubjects.dynamic_tool_call_end, {
        threadId: notification.threadId,
        turnId: notification.turnId,
        itemId,
        name: cached.name,
        output: cached.output,
        success: cached.success,
        timestamp: Date.now(),
      });
      dynamicToolCallCache.delete(itemId);
    } else {
      console.warn(`[lifecycle-handlers] dynamicToolCall item ${itemId} completed with no cached tool call data`);
    }
    return;
  }

  // For all other item types, emit item_completed so downstream handlers (e.g. agent.ts)
  // can react to completion without type-switching on individual item types.
  await emit(CodexAppServerSubjects.item_completed, {
    threadId: notification.threadId,
    turnId: notification.turnId,
    itemId,
    itemType,
    timestamp: Date.now(),
  });
}

/**
 * Handle token usage updated notification.
 * @param notification - Token usage notification
 * @param thread - Current thread instance
 */
export async function handleTokenUsageUpdated(
  notification: ThreadTokenUsageUpdatedNotification,
  thread: CodexAppServerThread | undefined,
): Promise<void> {
  if (!thread) return;

  await thread.handleTokenUsageUpdated(
    notification.tokenUsage.last.inputTokens,
    notification.tokenUsage.last.cachedInputTokens,
    notification.tokenUsage.last.outputTokens,
    notification.tokenUsage.last.reasoningOutputTokens,
    notification.tokenUsage.last.totalTokens,
    notification.tokenUsage.modelContextWindow ?? undefined,
  );
}
