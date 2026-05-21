import { z } from 'zod';

/**
 * RPC schema for resolving a session's system prompt.
 *
 * Framework adapters use this RPC during rehydration to obtain the resolved
 * system prompt without importing host-tier persona/profile code. The
 * host-tier handler performs a best-effort lookup: persona resolution
 * (via `PersonaSubjects.resolve`) then profile lookup (via `ProfileSubjects.get`).
 * When neither produces a prompt, the handler leaves the result unset so
 * `requestOptional` returns `{ handled: false }` and the caller applies
 * its own fallback.
 *
 * `sessionId` is accepted for future session-override support but is not
 * currently used by the handler.
 */
export const ResolveSystemPromptSchema = {
  /**
   * Resolve the fully-assembled system prompt for a given session.
   *
   * Subject: `session.resolveSystemPrompt`
   * Type: Request (RPC)
   * @example
   * ```typescript
   * const { systemPrompt } = await bus.request(
   *   SessionSubjects.resolveSystemPrompt,
   *   { sessionId: 'session-uuid' },
   * );
   * ```
   */
  resolveSystemPrompt: {
    request: z.object({
      /** Session identifier to resolve the prompt for. */
      sessionId: z.string(),
      /**
       * Optional persona identifier override.
       * When omitted, persona lookup is skipped.
       */
      personaId: z.string().optional(),
      /**
       * Optional profile identifier override.
       * When omitted, profile lookup is skipped.
       */
      profileId: z.string().optional(),
    }),
    response: z.object({
      /** The fully-resolved system prompt text. */
      systemPrompt: z.string(),
      /** Persona display name (for logging/display purposes). */
      personaName: z.string().optional(),
      /** Profile display name (for logging/display purposes). */
      profileName: z.string().optional(),
    }),
  },
};

/** Inferred request type for `session.resolveSystemPrompt`. */
export type ResolveSystemPromptRequest = z.infer<typeof ResolveSystemPromptSchema.resolveSystemPrompt.request>;

/** Inferred response type for `session.resolveSystemPrompt`. */
export type ResolveSystemPromptResponse = z.infer<typeof ResolveSystemPromptSchema.resolveSystemPrompt.response>;
