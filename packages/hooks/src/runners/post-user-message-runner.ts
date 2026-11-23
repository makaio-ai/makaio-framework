import type { CallContext } from '@makaio/core';
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
 *
 * Each hook receives the bus of the extension that registered it
 * (`options.bus`), never a bus of the caller of this runner. The runner does not
 * send itself.
 * @param call - Call context of the message that triggered the turn; carried on every hook context
 * @param input - Input containing agent/session identifiers
 * @returns Promise that resolves when all hooks complete
 */
export async function runPostUserMessageHooks(call: CallContext, input: PostUserMessageInput): Promise<void> {
  for (const { name, handler, options } of registry) {
    const ctx: PostUserMessageContext = {
      hookEvent: 'PostUserMessage',
      agentId: input.agentId,
      adapterId: input.adapterId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      bus: options.bus,
      call,
    };

    try {
      await handler(ctx);
    } catch (err) {
      console.error(`[PostUserMessage] Hook "${name}" failed:`, err);
      // Continue to next hook (don't block on errors)
    }
  }
}
