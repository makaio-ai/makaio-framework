/**
 * `\@makaio/agent-sdk` — `/runtime` entry point.
 *
 * Boots an embedded Makaio runtime in-process on first use and exposes the
 * full SDK surface.  Use this entry point when running Node.js scripts that
 * should manage their own Makaio runtime without a separate server process.
 * @example
 * ```typescript
 * import { query, startup, shutdown } from '@makaio/agent-sdk/runtime';
 *
 * await startup();
 *
 * const result = query({ prompt: 'Summarise this file', options: { model: 'sonnet' } });
 * for await (const message of await result) {
 *   console.log(message);
 * }
 *
 * await shutdown();
 * ```
 */

// ---------------------------------------------------------------------------
// Shared types, errors, and utilities — identical surface in both entry points.
// ---------------------------------------------------------------------------
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKAssistantMessagePayload,
  SDKAssistantMessageError,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKToolResultMessage,
  SDKUsage,
  SDKMessageOrigin,
  SDKToolProgressMessage,
  SDKStatus,
  SDKStatusMessage,
  SDKSessionStateChangedMessage,
  ApiKeySource,
  PermissionMode,
  FastModeState,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  TextCitation,
  ModelInfo,
  AccountInfo,
  McpServerStatus,
  SlashCommand,
  PermissionResult,
  CanUseToolCallback,
  MakaioOptions,
  McpServerConfig,
  McpSdkServerConfig,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
  CreateSdkMcpServerOptions,
  QueryParams,
  StartupParams,
  MakaioToolDefinition,
  MakaioQuery,
  SDKSessionInfo,
  SessionMessage,
  ListSessionsOptions,
  ForkSessionOptions,
  ForkSessionResult,
} from '../shared/index.js';

export {
  MakaioCredentialError,
  MakaioConnectionError,
  MakaioModelError,
  MakaioUnsupportedFeatureError,
} from '../shared/index.js';

export { tool } from '../shared/index.js';

export type { HookEvent, HookEventData, HookCallback, HookConfig } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Runtime-specific exports.
// ---------------------------------------------------------------------------
export { query, startup, registerRuntimeHooks, buildMcpSessionContext, createSdkMcpServer } from './query.js';
export { ensureRuntime, shutdownRuntime as shutdown } from './boot.js';

// ---------------------------------------------------------------------------
// Curried session management — bus obtained from the embedded runtime.
// ---------------------------------------------------------------------------

import { ensureRuntime } from './boot.js';
import {
  listSessions as listSessionsShared,
  getSessionInfo as getSessionInfoShared,
  getSessionMessages as getSessionMessagesShared,
  forkSession as forkSessionShared,
  deleteSession as deleteSessionShared,
  renameSession as renameSessionShared,
} from '../shared/sessions.js';
import {
  supportedModels as supportedModelsShared,
  mcpServerStatus as mcpServerStatusShared,
  accountInfo as accountInfoShared,
  supportedCommands,
} from '../shared/introspection.js';
import { registerHooks as registerHooksShared } from '../shared/hooks.js';
import type {
  SDKSessionInfo,
  SessionMessage,
  ListSessionsOptions,
  ForkSessionOptions,
  ForkSessionResult,
  ModelInfo,
  McpServerStatus,
  AccountInfo,
} from '../shared/types.js';
import type { HookConfig } from '../shared/hooks.js';

export { supportedCommands };

/**
 * List sessions from the embedded runtime.
 * @param options - Optional filters for status and pagination.
 * @returns Array of SDK session info objects.
 */
export async function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
  const bus = await ensureRuntime();
  return listSessionsShared(bus, options);
}

/**
 * Get info for a single session by ID.
 * @param sessionId - The session ID to retrieve.
 * @returns SDK session info, or undefined if the session does not exist.
 */
export async function getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
  const bus = await ensureRuntime();
  return getSessionInfoShared(bus, sessionId);
}

/**
 * Retrieve all stored messages for a session.
 * @param sessionId - The session whose messages should be retrieved.
 * @returns Ordered array of SDK session messages.
 */
export async function getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  const bus = await ensureRuntime();
  return getSessionMessagesShared(bus, sessionId);
}

/**
 * Fork a session from an optional branch point.
 * @param sessionId - Source session to fork from.
 * @param options - Optional fork options including message branch point.
 * @returns The new session ID created by the fork.
 */
export async function forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult> {
  const bus = await ensureRuntime();
  return forkSessionShared(bus, sessionId, options);
}

/**
 * Delete a session permanently: close → archive → purge.
 * @param sessionId - The session ID to permanently delete.
 * @returns Resolves when the session has been purged.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const bus = await ensureRuntime();
  return deleteSessionShared(bus, sessionId);
}

/**
 * Rename a session by updating its title.
 * @param sessionId - The session ID to rename.
 * @param title - New display title for the session.
 * @returns Resolves when the title has been updated.
 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  const bus = await ensureRuntime();
  return renameSessionShared(bus, sessionId, title);
}

// ---------------------------------------------------------------------------
// Curried introspection — bus obtained from the embedded runtime.
// ---------------------------------------------------------------------------

/**
 * Return all models available across all providers.
 * @returns Array of model info objects.
 */
export async function supportedModels(): Promise<ModelInfo[]> {
  const bus = await ensureRuntime();
  return supportedModelsShared(bus);
}

/**
 * Return the status of configured MCP servers for a session.
 * @param sessionId - Makaio session ID to scope the lookup.
 * @returns Array of server status objects, or empty array when `sessionId` is omitted.
 */
export async function mcpServerStatus(sessionId?: string): Promise<McpServerStatus[]> {
  const bus = await ensureRuntime();
  return mcpServerStatusShared(bus, sessionId);
}

/**
 * Return account information for the active provider.
 * @param adapterName - Optional name of the active adapter/provider.
 * @returns Account info with the provider name set, email omitted.
 */
export async function accountInfo(adapterName?: string): Promise<AccountInfo> {
  const bus = await ensureRuntime();
  return accountInfoShared(bus, adapterName);
}

// ---------------------------------------------------------------------------
// Curried hook registration — bus obtained from the embedded runtime.
// ---------------------------------------------------------------------------

/**
 * Register Claude SDK hook callbacks as bus event subscriptions against the
 * embedded runtime.
 *
 * For each hook event in `hooks` that has a Makaio bus equivalent, this
 * function registers a `bus.on()` handler filtered to the given `sessionId`.
 * Hook events without a bus equivalent are silently ignored.
 * @param sessionId - Session ID used to filter bus events.
 * @param hooks - Map of hook event names to callbacks.
 * @returns A cleanup function that removes all registered subscriptions.
 */
export async function registerHooks(sessionId: string, hooks: HookConfig): Promise<() => void> {
  const bus = await ensureRuntime();
  return registerHooksShared(bus, sessionId, hooks);
}
