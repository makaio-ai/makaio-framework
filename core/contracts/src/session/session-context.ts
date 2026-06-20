import { z } from 'zod';
import { MessageSchema, JsonValueSchema } from '../shared/index.js';

export const CACHE_STRATEGIES = ['auto', 'systemPrompt', 'fullPrefix'] as const;
export type CacheStrategy = (typeof CACHE_STRATEGIES)[number];

/**
 * Context signals assembled by SessionOrchestrator and flowed to adapters.
 * Agent uses these to decide: native resume vs fresh with history.
 */
export const SessionContextSchema = z.object({
  /**
   * Curated message history assembled via getFullConversation().
   * Only used if Agent decides to inject (fresh mode).
   */
  messageHistory: z.array(MessageSchema).optional(),

  /**
   * Whether transforms have been applied since last turn.
   * If true, Agent should use fresh mode (history changed).
   */
  hasNewTransforms: z.boolean().optional(),

  /**
   * Whether compression is active (extractedContext present).
   * If true, Agent should use fresh mode with compressed context.
   */
  hasCompression: z.boolean().optional(),

  /**
   * Structured context from compression (if hasCompression=true).
   */
  extractedContext: z.unknown().optional(),

  /**
   * Whether this is the first turn in the session.
   * If true, no native history exists yet.
   */
  isFirstTurn: z.boolean().optional(),

  /**
   * Whether a connector swap occurred before this message (e.g., cwd/model change).
   * If true, native resume is infeasible and adapters should use fresh mode.
   */
  hasConnectorSwap: z.boolean().optional(),

  /**
   * Caller-expressed caching intent for stateless continuation sessions.
   * Valid values are defined by {@link CACHE_STRATEGIES}; adapters map the
   * selected strategy to provider-specific mechanisms.
   */
  cacheStrategy: z.enum(CACHE_STRATEGIES).optional(),

  /**
   * Turn-scoped context assembled by PreUserMessage hooks and the orchestrator.
   * Keys are plugin-defined (e.g., 'skillCatalog', 'skills', 'predictedTools').
   * Adapters consume this to prepend context blocks.
   *
   * Constrained to JSON-safe types to ensure serialization succeeds.
   *
   * ADAPTER CONTRACT: Every adapter MUST materialize turnContext into the
   * LLM-facing message using serializeTurnContext().
   */
  turnContext: z.record(z.string(), JsonValueSchema).optional(),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
