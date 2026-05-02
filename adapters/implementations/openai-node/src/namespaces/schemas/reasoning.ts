/**
 * Reasoning schemas for the OpenAI Node adapter.
 *
 * The base schemas from `@makaio/ai-adapters-stream-session` match the OpenAI
 * structure exactly (no adapter-specific extensions needed), so they are
 * re-exported directly.
 */
export { ReasoningDeltaEventSchema, ReasoningCompleteEventSchema } from '@makaio/ai-adapters-stream-session';
export type { ReasoningDeltaEvent, ReasoningCompleteEvent } from '@makaio/ai-adapters-stream-session';
