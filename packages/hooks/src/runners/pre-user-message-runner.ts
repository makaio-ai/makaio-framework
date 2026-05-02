import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionContext, MessageInput, JsonValue } from '@makaio/contracts';
import { fetchSessionEnrichment, EMPTY_ENRICHMENT } from '../contexts/session-enrichment.js';
import type { PreUserMessageHookOptions } from '../types/hook-options.js';
import type { PreUserMessageContext } from '../types/hook-context.js';
import { HookAbortError } from '../errors/hook-abort-error.js';
import { HookRegistry } from './hook-registry.js';

const registry = new HookRegistry<PreUserMessageContext, PreUserMessageHookOptions>();

/**
 * Register a PreUserMessage hook.
 * @param name - Hook name for error attribution
 * @param handler - Hook handler function
 * @param options - Hook configuration options
 * @param priority - Handler priority (higher runs first, default: 0)
 * @returns Unsubscribe function
 */
export function registerPreUserMessageHook(
  name: string,
  handler: (ctx: PreUserMessageContext) => void | Promise<void>,
  options: PreUserMessageHookOptions,
  priority = 0,
): () => void {
  return registry.register(name, handler, options, priority);
}

/**
 * Reset all hooks. For testing only.
 * Call explicitly in beforeEach() to prevent test pollution.
 */
export function resetPreUserMessageHooks(): void {
  registry.reset();
}

export interface PreUserMessageInput {
  agentId?: string;
  adapterId?: string;
  message: MessageInput;
  sessionId?: string;
  sessionContext?: SessionContext;
  messageId?: string;
  cwd?: string;
}

export interface PreUserMessageResult {
  message: MessageInput;
  sessionContext?: SessionContext;
}

/**
 * Run all registered PreUserMessage hooks.
 * @param input - Input containing message and context
 * @param bus - Bus instance for session enrichment
 * @returns Result with potentially modified message and sessionContext
 * @throws HookAbortError if a hook calls abort()
 */
export async function runPreUserMessageHooks(
  input: PreUserMessageInput,
  bus: IMakaioBus,
): Promise<PreUserMessageResult> {
  let currentMessage = input.message;
  let currentSessionContext = input.sessionContext;

  const enriched = input.sessionId ? await fetchSessionEnrichment(bus, input.sessionId) : EMPTY_ENRICHMENT;

  for (const { name, handler } of registry) {
    const hookTurnContext: Record<string, JsonValue> = {};

    const ctx: PreUserMessageContext = {
      ...enriched.contextExtensions,
      get payload() {
        return {
          message: currentMessage,
          sessionId: input.sessionId,
          sessionContext: currentSessionContext,
          cwd: input.cwd,
          adapterId: input.adapterId,
          agentId: input.agentId,
        };
      },
      messageId: input.messageId,
      correlationId: undefined,

      replacePayload: (newPayload) => {
        if (newPayload.message !== undefined) currentMessage = newPayload.message;
        if (newPayload.sessionContext !== undefined) currentSessionContext = newPayload.sessionContext;
      },

      next: async () => {},

      abort: (reason?: string): never => {
        throw new HookAbortError(name, reason);
      },

      hookEvent: 'PreUserMessage',
      session: enriched.session,
      recentHistory: enriched.recentHistory,
      contextExtensions: enriched.contextExtensions,
      bus,

      setTurnContext(key: string, value: JsonValue) {
        hookTurnContext[key] = value;
      },
      getTurnContext(): Record<string, JsonValue> {
        return { ...hookTurnContext };
      },
    };

    await handler(ctx);

    // Merge after handler completes (accumulates across hooks)
    const turnContext = ctx.getTurnContext();
    if (Object.keys(turnContext).length > 0) {
      const existing = currentSessionContext?.turnContext ?? {};
      // Cast turn context - hooks should provide JSON-safe values
      // Runtime validation happens at schema level if enabled
      const mergedTurnContext = {
        ...existing,
        ...turnContext,
      } as SessionContext['turnContext'];
      currentSessionContext = {
        ...currentSessionContext,
        turnContext: mergedTurnContext,
      };
    }
  }

  return { message: currentMessage, sessionContext: currentSessionContext };
}
