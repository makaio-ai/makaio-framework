/**
 * Utility functions for AI adapter implementations.
 */

export { safeJsonStringify } from './safeJsonStringify.js';

// Turn context serialization
export {
  serializeTurnContext,
  formatContextBlockAsText,
  formatContextBlocksAsText,
  type SerializedContextBlock,
} from './serializeTurnContext.js';

export { parseAIAdapterCapabilities } from './capabilities.js';
export { cleanEnvForAdapter } from './cleanEnvForAdapter.js';
export { normalizeMessageInput, type NormalizedMessageInput } from './normalizeMessageInput.js';

// Discriminated handler utilities for type-safe event processing
export {
  defineDiscriminatedHandlers,
  defineDiscriminatedHandlersSync,
  processDiscriminatedItems,
  processDiscriminatedItemsSync,
  type TypedEmitFn,
  type SyncTypedEmitFn,
  type DiscriminatedHandler,
  type SyncDiscriminatedHandler,
  type DiscriminatedHandlersMap,
  type SyncDiscriminatedHandlersMap,
  type DiscriminatedHandlersConfig,
  type SyncDiscriminatedHandlersConfig,
} from './discriminated-handlers.js';

export { normalizeEnvValue } from './normalizeEnvValue.js';
export { resolveTestConfig, createTestProviderContext } from './resolveTestConfig.js';
export {
  MAKAIO_CONFORMANCE_PROVIDER_ENV,
  MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV,
  MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV,
  MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV,
  resolveConformanceTestPreset,
  type ConformanceEnvReader,
  type ResolveConformanceTestPresetOptions,
  type ResolvedConformanceTestPreset,
} from './resolveConformanceTestPreset.js';
export { resolveDisabledNativeTools, type HarnessRequester } from './resolveDisabledNativeTools.js';

// Message formatting utilities
export { formatMessageHistoryAsTranscript } from './formatMessageHistoryAsTranscript.js';
export { serializeBlockToText } from './serialize-block-to-text.js';

// Tool approval shared types and utilities
export {
  ScopedToolApprovalSchema,
  createToolApprovalHandler,
  mergeScopedToolApproval,
  resolveRequiredSessionId,
  type MergeScopedToolApprovalOptions,
  type ScopedToolApprovalRequest,
  type ScopedToolApprovalResponse,
  type ToolApprovalContext,
  type ToGlobalToolApprovalFn,
  type FromGlobalToolApprovalFn,
} from './tool-approval.js';

// MIME type normalization and classification utilities
export { normalizeMimeType, isTextLikeMimeType } from './normalizeMimeType.js';

// Provider credential resolution

// Closed provider-less context for paths that bypass orchestrator resolution
export { createUnresolvedProviderContext } from './provider-context.js';
