import { z } from 'zod';
import type { PlanEntry } from './_acp-types.js';

/**
 * Plan event schema for Gemini ACP.
 * Represents the agent's plan with prioritized task entries.
 *
 * Each entry contains:
 * - content: Description of the task
 * - priority: Task priority (high, medium, low)
 * - status: Current status (pending, in_progress, completed)
 *
 * Note: gemini-cli bundles Zod v3, we use v4. Using z.custom<T>() for type safety.
 */
export type PlanEvent = {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
};

export const PlanEventSchema = z.custom<PlanEvent>(() => true);
