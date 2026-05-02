import type { IMakaioBus } from '@makaio/bus-core';
import type { PostUserMessageHookOptions } from '../types/hook-options.js';
import type { PostUserMessageContext } from '../types/hook-context.js';
import { HookRegistry } from './hook-registry.js';

const registry = new HookRegistry<PostUserMessageContext, PostUserMessageHookOptions>();

/**
 * Register a PostUserMessage hook.
 * @param name - Hook name for error attribution
 * @param handler - Hook handler function
 * @param options - Hook configuration options
 * @param priority - Handler priority (higher runs first, default: 0)
 * @returns Unsubscribe function
 */
export function registerPostUserMessageHook(
  name: string,
  handler: (ctx: PostUserMessageContext) => void | Promise<void>,
  options: PostUserMessageHookOptions,
  priority = 0,
): () => void {
  return registry.register(name, handler, options, priority);
}

/**
 * Reset all hooks. For testing only.
 * Call explicitly in beforeEach() to prevent test pollution.
 */
export function resetPostUserMessageHooks(): void {
  registry.reset();
}

export interface PostUserMessageInput {
  agentId: string;
  adapterId: string;
  sessionId?: string;
  messageId?: string;
}

/**
 * Run all registered PostUserMessage hooks.
 * @param input - Input containing agent/session identifiers
 * @param bus - Bus instance for making requests
 * @returns Promise that resolves when all hooks complete
 */
export async function runPostUserMessageHooks(input: PostUserMessageInput, bus: IMakaioBus): Promise<void> {
  for (const { name, handler } of registry) {
    const ctx: PostUserMessageContext = {
      hookEvent: 'PostUserMessage',
      agentId: input.agentId,
      adapterId: input.adapterId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      bus,
    };

    try {
      await handler(ctx);
    } catch (err) {
      console.error(`[PostUserMessage] Hook "${name}" failed:`, err);
      // Continue to next hook (don't block on errors)
    }
  }
}
