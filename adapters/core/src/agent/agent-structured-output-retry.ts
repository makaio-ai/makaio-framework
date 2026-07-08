import type { ResponseSchemaDescriptor } from '@makaio/contracts';
import type { MessageHandle, MessageResult } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { AgentStructuredOutputManager } from './agent-structured-output-manager.js';

/**
 * Dependencies for {@link createStructuredOutputTerminalTransform}.
 */
export interface StructuredOutputTerminalTransformDeps {
  /** Validation specialist that owns schema checks, retry policy, and enforcement. */
  structuredOutputManager: AgentStructuredOutputManager;
  /** Live connector accessor — resolved per retry so connector swaps stay safe. */
  getConnector: () => AIAgentConnector | undefined;
  /** Session identifier forwarded to the enforce RPC handler. */
  sessionId: string | undefined;
  /** Message handle of the turn whose terminal output is validated. */
  messageHandle: MessageHandle;
  /** Schema descriptor the terminal output must conform to. */
  responseSchema: ResponseSchemaDescriptor;
}

/**
 * Create the terminal-result transform for a structured-output turn.
 *
 * Bridges the validation specialist ({@link AgentStructuredOutputManager}) to
 * turn dispatch: validation retries re-send the original message through the
 * connector with retry context, so the manager itself stays free of
 * connector/message-handle knowledge.
 * @param deps - Manager, connector accessor, and turn context
 * @returns Transform applied to the tracked terminal {@link MessageResult}
 */
export function createStructuredOutputTerminalTransform(
  deps: StructuredOutputTerminalTransformDeps,
): (result: MessageResult) => Promise<MessageResult> {
  const { structuredOutputManager, getConnector, sessionId, messageHandle, responseSchema } = deps;
  return async (result: MessageResult): Promise<MessageResult> => {
    if (result.outcome !== 'completed') return result;

    const validated = await structuredOutputManager.validateTerminalResult({
      responseSchema,
      message: result.result?.message,
      sessionId,
      retryTurn: async ({ attemptNumber, validationErrors }) => {
        const connector = getConnector();
        if (!connector) return '';
        // Internal retry emissions are provisional. SessionBridge persists
        // structured-output turns from the validated agent.complete.message
        // so invalid attempt blocks cannot be flushed as the assistant turn.
        const retryHandle = await connector.sendMessage(messageHandle.message, {
          deliveryMode: 'enqueue',
          internalRetry: true,
          messageId: `${messageHandle.messageId}:structured-output-retry:${attemptNumber}`,
          messageHistory: messageHandle.messageHistory,
          responseSchema,
          turnContext: {
            ...messageHandle.turnContext,
            structuredOutputRetry: {
              attemptNumber,
              validationErrors,
              instruction: 'Previous output did not match the requested JSON schema. Respond only with corrected JSON.',
            },
          },
        });
        const retryResult = await retryHandle.waitForCompletion();
        return retryResult.result?.message ?? '';
      },
    });

    return {
      ...result,
      result:
        result.result !== null && result.result !== undefined
          ? { ...result.result, message: validated.message }
          : result.result,
      structuredOutputValidation: validated.structuredOutputValidation,
    };
  };
}
