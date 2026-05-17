import { z } from 'zod';
import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import { TurnStateChangedSchema } from '@makaio/ai-adapters-stream-session';
import type { ScopedBus } from '@makaio/bus-core';

/** Bus namespace domain for the Claude Code tmux adapter. */
export const CLAUDE_CODE_TMUX_NAMESPACE = 'adapter:claude-code-tmux' as const;

/**
 * Payload for `turn.turn_completed` — carries the assistant's final response text.
 *
 * Distinct from `turn.turn_finished` (a state-machine transition signal):
 * `turn_completed` is the semantic "assistant produced a response" event that
 * the agent layer translates to `AgentSubjects.message` for session persistence.
 */
export const TurnCompletedSchema = z.object({
  /** Final assistant response text from the Stop hook. */
  message: z.string(),
});

/** Payload for `tool_use.started` — metadata from the PreToolUse hook. */
export const TmuxToolUseStartedSchema = z.object({
  /** Claude Code-native tool use identifier. */
  toolUseId: z.string(),
  /** Name of the tool being invoked. */
  toolName: z.string(),
  /** Raw tool input from the PreToolUse hook. */
  toolInput: z.unknown().optional(),
});

/** Payload for `tool_use.finished` — metadata from the PostToolUse hook. */
export const TmuxToolUseFinishedSchema = z.object({
  /** Claude Code-native tool use identifier (correlates with tool_use.started). */
  toolUseId: z.string(),
  /** Name of the tool that completed. */
  toolName: z.string(),
  /** Raw tool result or error payload from the PostToolUse hook. */
  toolResult: z.unknown().optional(),
  /** Whether Claude Code reported the tool call as failed. */
  isError: z.boolean().optional(),
});

/**
 * Claude Code tmux adapter namespace with typed subject definitions.
 *
 * Unlike the CLI/SDK adapters which emit raw SDK streaming events, the tmux
 * adapter is hook-driven — turn state transitions come from Claude Code's
 * hook system, not from parsing a JSON stream. The namespace exposes:
 *
 * - Turn lifecycle subjects (state machine transitions + completion payload)
 * - Tool use subjects (metadata from PreToolUse/PostToolUse hooks)
 * - Tool approval RPC (same as other adapters)
 */
export const ClaudeCodeTmuxConnectorNamespace = createAdapterNamespace(CLAUDE_CODE_TMUX_NAMESPACE, {
  tool_approval: ScopedToolApprovalSchema,

  'tool_use.started': TmuxToolUseStartedSchema,
  'tool_use.finished': TmuxToolUseFinishedSchema,

  'turn.state_changed': TurnStateChangedSchema,
  'turn.turn_started': TurnStateChangedSchema,
  'turn.step_started': TurnStateChangedSchema,
  'turn.step_finished': TurnStateChangedSchema,
  'turn.turn_finished': TurnStateChangedSchema,
  'turn.turn_completed': TurnCompletedSchema,
});

/** Typed subject literals for the Claude Code tmux adapter namespace. */
export const ClaudeCodeTmuxConnectorSubjects = ClaudeCodeTmuxConnectorNamespace.subjects;

/** Scoped bus type for the Claude Code tmux adapter namespace. */
export type ClaudeCodeTmuxConnectorBus = ScopedBus<typeof CLAUDE_CODE_TMUX_NAMESPACE>;
