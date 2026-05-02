/**
 * ACP SDK Type Re-exports
 *
 * Single barrel file for `@agentclientprotocol/sdk` types and schemas.
 * Centralizes imports so SDK path changes only require updating this file.
 *
 * These types are used for ACP protocol compatibility in the Gemini adapter.
 * TypeScript will catch drift at compile time when gemini-cli is updated.
 */

// Types from ACP SDK
export type {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  ToolCallStatus,
  SessionNotification,
} from '@agentclientprotocol/sdk';
