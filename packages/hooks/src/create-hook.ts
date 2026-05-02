import { MakaioBus, type InterceptorContext } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type StepFinished, type StepType } from '@makaio/contracts';
import type { ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import { buildPostTurnContext } from './contexts/post-turn.js';
import { buildPostStepContext } from './contexts/post-step.js';
import { registerPreUserMessageHook } from './runners/pre-user-message-runner.js';
import { registerPostUserMessageHook } from './runners/post-user-message-runner.js';
import type { HookName } from './types/hook-name.js';
import type {
  BusMessageContext,
  PreUserMessageContext,
  PostUserMessageContext,
  PreTurnContext,
  PostTurnContext,
  PostStepContext,
  PreToolUseContext,
  PostToolUseContext,
  SessionStartContext,
  SessionEndContext,
} from './types/hook-context.js';
import type {
  BusMessageHookOptions,
  PreUserMessageHookOptions,
  PostUserMessageHookOptions,
  PreTurnHookOptions,
  PostTurnHookOptions,
  PostStepHookOptions,
  PreToolUseHookOptions,
  PostToolUseHookOptions,
  SessionStartHookOptions,
  SessionEndHookOptions,
} from './types/hook-options.js';

/** Session-level turn.completed payload */
type SessionTurnCompleted = ExtractSubjectPayload<typeof SessionSubjects.turn.completed>;

/**
 * Runs a hook handler with error handling and context enrichment.
 * Ensures rawCtx.next() is always called, even if handler throws.
 * @param hookType - Hook type for error logging (e.g., 'PostTurn', 'PostStep')
 * @param hookName - Hook name for error logging
 * @param buildContext - Function to build enriched context from raw context
 * @param handler - Hook handler to execute with enriched context
 * @param next - Continuation function to call after handler completes
 */
async function runHookWithErrorHandling<T>(
  hookType: string,
  hookName: string,
  buildContext: () => Promise<T>,
  handler: (ctx: T) => void | Promise<void>,
  next: () => void | Promise<void>,
): Promise<void> {
  try {
    const ctx = await buildContext();
    await handler(ctx);
  } catch (error) {
    console.error(`[${hookType}] Hook '${hookName}' error:`, error);
  }
  await next();
}

/**
 * Hook registration result.
 */
export interface HookRegistration {
  /** Unsubscribe from the hook */
  unsubscribe: () => void;
  /** Hook name for identification */
  hookName: HookName;
}

/**
 * Conditional options type - inferred from hook name.
 */
export type HookOptions<K extends HookName, S extends SubjectDefinition = SubjectDefinition> = K extends 'BusMessage'
  ? BusMessageHookOptions<S>
  : K extends 'PreUserMessage'
    ? PreUserMessageHookOptions
    : K extends 'PostUserMessage'
      ? PostUserMessageHookOptions
      : K extends 'PreTurn'
        ? PreTurnHookOptions
        : K extends 'PostTurn'
          ? PostTurnHookOptions
          : K extends 'PostStep'
            ? PostStepHookOptions
            : K extends 'PreToolUse'
              ? PreToolUseHookOptions
              : K extends 'PostToolUse'
                ? PostToolUseHookOptions
                : K extends 'SessionStart'
                  ? SessionStartHookOptions
                  : K extends 'SessionEnd'
                    ? SessionEndHookOptions
                    : never;

/**
 * Conditional context type - what handler receives.
 */
export type HookContext<K extends HookName, S extends SubjectDefinition = SubjectDefinition> = K extends 'BusMessage'
  ? BusMessageContext<ExtractSubjectPayload<S>>
  : K extends 'PreUserMessage'
    ? PreUserMessageContext
    : K extends 'PostUserMessage'
      ? PostUserMessageContext
      : K extends 'PreTurn'
        ? PreTurnContext
        : K extends 'PostTurn'
          ? PostTurnContext
          : K extends 'PostStep'
            ? PostStepContext
            : K extends 'PreToolUse'
              ? PreToolUseContext
              : K extends 'PostToolUse'
                ? PostToolUseContext
                : K extends 'SessionStart'
                  ? SessionStartContext
                  : K extends 'SessionEnd'
                    ? SessionEndContext
                    : never;

/**
 * Create a typed hook registration.
 * @param name - Hook name (BusMessage for generic, or named hooks for enriched context)
 * @param options - Hook-specific options including handler
 * @returns HookRegistration with unsubscribe function
 * @example BusMessage (generic escape hatch)
 * ```typescript
 * createHook('BusMessage', {
 *   subject: AgentSubjects.tool.use,
 *   handler: (ctx) => {
 *     if (ctx.payload.toolName === 'dangerous') {
 *       ctx.stopPropagation();
 *     }
 *   },
 * });
 * ```
 */
// eslint-disable-next-line max-lines-per-function -- Switch-like dispatch pattern, legitimate length
export function createHook<K extends HookName, S extends SubjectDefinition = SubjectDefinition>(
  name: K,
  options: HookOptions<K, S> & {
    handler: (ctx: HookContext<K, S>) => void | Promise<void>;
    priority?: number;
  },
): HookRegistration {
  if (name === 'BusMessage') {
    const busOptions = options as BusMessageHookOptions<S> & {
      handler: (ctx: BusMessageContext<ExtractSubjectPayload<S>>) => void | Promise<void>;
      priority?: number;
    };

    const unsubscribe = MakaioBus.intercept(busOptions.subject, busOptions.handler, {
      priority: busOptions.priority,
    });

    return { unsubscribe, hookName: name };
  }

  if (name === 'PreUserMessage') {
    const preUserOptions = options as PreUserMessageHookOptions & {
      handler: (ctx: PreUserMessageContext) => void | Promise<void>;
    };

    const unsubscribe = registerPreUserMessageHook(
      preUserOptions.name ?? 'anonymous',
      preUserOptions.handler,
      preUserOptions,
      preUserOptions.priority ?? 0,
    );

    return { unsubscribe, hookName: name };
  }

  if (name === 'PostUserMessage') {
    const postUserOptions = options as PostUserMessageHookOptions & {
      handler: (ctx: PostUserMessageContext) => void | Promise<void>;
      name?: string;
    };

    const unsubscribe = registerPostUserMessageHook(
      postUserOptions.name ?? 'anonymous',
      postUserOptions.handler,
      postUserOptions,
      postUserOptions.priority ?? 0,
    );

    return { unsubscribe, hookName: name };
  }

  if (name === 'PostTurn') {
    const postTurnOptions = options as PostTurnHookOptions & {
      handler: (ctx: PostTurnContext) => void | Promise<void>;
      priority?: number;
    };
    const hookName = postTurnOptions.name ?? 'anonymous';

    // Intercept session.turn.completed event
    const unsubscribe = MakaioBus.intercept(
      SessionSubjects.turn.completed,
      async (rawCtx: InterceptorContext<SessionTurnCompleted>) => {
        await runHookWithErrorHandling(
          'PostTurn',
          hookName,
          () => buildPostTurnContext(rawCtx, MakaioBus),
          postTurnOptions.handler,
          () => rawCtx.next(),
        );
      },
      { priority: postTurnOptions.priority },
    );

    return { unsubscribe, hookName: name };
  }

  if (name === 'PostStep') {
    const postStepOptions = options as PostStepHookOptions & {
      handler: (ctx: PostStepContext) => void | Promise<void>;
      priority?: number;
    };

    // Default to reasoning-only if not specified
    const stepTypes: StepType[] = postStepOptions.stepTypes ?? ['reasoning'];
    const hookName = postStepOptions.name ?? 'anonymous';

    // Intercept agent.step.finished event
    const unsubscribe = MakaioBus.intercept(
      AgentSubjects.step.finished,
      async (rawCtx: InterceptorContext<StepFinished>) => {
        // Apply step type filter BEFORE enrichment to avoid unnecessary queries
        if (!stepTypes.includes(rawCtx.payload.stepType)) {
          await rawCtx.next();
          return;
        }

        await runHookWithErrorHandling(
          'PostStep',
          hookName,
          () => buildPostStepContext(rawCtx, MakaioBus),
          postStepOptions.handler,
          () => rawCtx.next(),
        );
      },
      { priority: postStepOptions.priority },
    );

    return { unsubscribe, hookName: name };
  }

  // Other named hooks still throw
  throw new Error(`Named hook "${name}" not yet implemented. Use BusMessage for now.`);
}
