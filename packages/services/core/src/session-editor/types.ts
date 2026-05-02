import { z } from 'zod';
import { SessionMessageSchema, type SessionMessage } from '@makaio/contracts';

/**
 * Category of pipeline action.
 */
export const ActionCategorySchema = z.enum(['compression', 'extraction', 'transformation']);
export type ActionCategory = z.infer<typeof ActionCategorySchema>;

/**
 * Result of a pipeline action - either transformed messages or a context JSON.
 */
export const ActionResultSchema = z.union([
  z.object({
    kind: z.literal('messages'),
    messages: z.array(SessionMessageSchema),
  }),
  z.object({
    kind: z.literal('context'),
    json: z.record(z.string(), z.unknown()),
    tokenEstimate: z.number().optional(),
  }),
]);
export type ActionResult = z.infer<typeof ActionResultSchema>;

/**
 * Definition of a pipeline action that can be registered and executed.
 */
export interface SessionEditorAction {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Description shown in UI */
  description: string;
  /** Category for grouping in UI */
  category: ActionCategory;
  /** Execute the action on messages */
  execute(messages: SessionMessage[], options?: Record<string, unknown>): Promise<ActionResult>;
  /** Optional: estimate resulting token count */
  estimateTokens?(messages: SessionMessage[]): Promise<number>;
}

/**
 * Pipeline step configuration (action + options).
 */
export interface PipelineStep {
  actionId: string;
  options?: Record<string, unknown>;
}
