import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Request to change the agent working directory.
 *
 * Subject: `agent.cwd.change`
 * Type: Request/Response
 * Sent when: Caller detects agent's cwd differs from desired cwd
 * Handler: AIAgent swaps connector with new cwd
 */
export const CwdChangeSchema = {
  request: BaseAgentEventSchema.extend({
    /** New working directory path */
    newCwd: z.string(),
    /** Skip interactive warning dialog for trusted/programmatic callers */
    skipWarning: z.boolean().optional(),
  }),
  response: z.object({
    /** Whether the cwd change was successful */
    success: z.boolean(),
    /** Reason for failure (only present when success is false) */
    reason: z.string().optional(),
    /** Previous cwd before swap (present when success=true and cwd changed) */
    previousCwd: z.string().optional(),
  }),
};

export type CwdChangeRequest = z.infer<typeof CwdChangeSchema.request>;
export type CwdChangeResponse = z.infer<typeof CwdChangeSchema.response>;

/**
 * Agent working directory changed.
 *
 * Subject: `agent.cwd.changed`
 * Type: Event (fire-and-forget)
 * Emitted when: Agent's working directory has been successfully changed
 * Use for: UI updates, audit logging
 */
export const CwdChangedSchema = BaseAgentEventSchema.extend({
  /** Previous working directory */
  previousCwd: z.string(),
  /** New working directory */
  newCwd: z.string(),
});

export type CwdChanged = z.infer<typeof CwdChangedSchema>;
