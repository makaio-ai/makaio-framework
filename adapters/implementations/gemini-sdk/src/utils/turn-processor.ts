import { type ServerGeminiStreamEvent, GeminiEventType } from '@google/gemini-cli-core';

/**
 * Get chunk type for state machine transitions.
 *
 * Maps raw SDK event types to semantic chunk types used by the agent's
 * state machine for tracking turn progress and managing immediate interrupts.
 * @param event - Turn stream event from Gemini SDK
 * @returns Chunk type for state tracking, or undefined for non-chunk events
 */
export function getChunkType(
  event: ServerGeminiStreamEvent,
): 'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | undefined {
  switch (event.type) {
    case GeminiEventType.Thought:
      return 'agent_thought_chunk';
    case GeminiEventType.Content:
      return 'agent_message_chunk';
    case GeminiEventType.ToolCallRequest:
      return 'tool_call';
    default:
      return undefined;
  }
}
