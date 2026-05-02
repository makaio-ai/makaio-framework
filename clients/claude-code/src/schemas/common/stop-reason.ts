import { z } from 'zod';

/**
 * The reason that we stopped generating.
 *
 * This may be one the following values:
 *
 * - `"end_turn"`: the model reached a natural stopping point
 * - `"max_tokens"`: we exceeded the requested `max_tokens` or the model's maximum
 * - `"stop_sequence"`: one of your provided custom `stop_sequences` was generated
 * - `"tool_use"`: the model invoked one or more tools
 * - `"pause_turn"`: we paused a long-running turn. You may provide the response
 * back as-is in a subsequent request to let the model continue.
 * - `"refusal"`: when streaming classifiers intervene to handle potential policy
 * violations
 * @see BetaStopReason from \@anthropic-ai/sdk
 */
export const BetaStopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
]);

export type BetaStopReason = z.infer<typeof BetaStopReasonSchema>;
