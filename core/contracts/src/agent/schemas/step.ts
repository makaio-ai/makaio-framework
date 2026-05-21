import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';
import { SessionMessageBlockSchema } from '../../session/index.js';

/**
 * Step type enumeration.
 * - reasoning: Thinking/extended thinking blocks
 * - tool_use: Tool invocation blocks
 * - text: Regular text/message blocks
 */
export const StepTypeSchema = z.enum(['reasoning', 'tool_use', 'text']);
export type StepType = z.infer<typeof StepTypeSchema>;

/**
 * Block data for tool_use steps.
 */
export const ToolUseBlockDataSchema = z.object({
  type: z.literal('tool_use'),
  toolName: z.string(),
  toolCallId: z.string(),
});

/**
 * Block data for reasoning steps.
 */
export const ReasoningBlockDataSchema = z.object({
  type: z.literal('reasoning'),
});

/**
 * Block data for text steps.
 */
export const TextBlockDataSchema = z.object({
  type: z.literal('text'),
});

/**
 * Discriminated union of block data by step type.
 */
export const BlockDataSchema = z.discriminatedUnion('type', [
  ToolUseBlockDataSchema,
  ReasoningBlockDataSchema,
  TextBlockDataSchema,
]);

export type BlockData = z.infer<typeof BlockDataSchema>;

/**
 * Agent step started event.
 *
 * Subject: `agent.step.started`
 * Type: Event (fire-and-forget)
 * Emitted when: A content block begins processing
 */
export const StepStartedSchema = BaseAgentEventSchema.extend({
  /** Message ID being processed */
  messageId: z.string().optional(),
  /** Step type (content block type) */
  stepType: StepTypeSchema,
  /** Content block index in the turn */
  blockIndex: z.number(),
  /** Content block metadata */
  blockData: BlockDataSchema.optional(),
  /** Step content (e.g., tool_call block for tool_use steps) */
  content: SessionMessageBlockSchema.optional(),
});

export type StepStarted = z.infer<typeof StepStartedSchema>;

/**
 * Agent step finished event.
 *
 * Subject: `agent.step.finished`
 * Type: Event (fire-and-forget)
 * Emitted when: A content block completes processing
 */
export const StepFinishedSchema = BaseAgentEventSchema.extend({
  /** Message ID being processed */
  messageId: z.string().optional(),
  /** Step type (content block type) */
  stepType: StepTypeSchema,
  /** Content block index in the turn */
  blockIndex: z.number(),
  /** Step content for PostStep hooks (text, reasoning, tool_call, or tool_output) */
  content: SessionMessageBlockSchema,
});

export type StepFinished = z.infer<typeof StepFinishedSchema>;
