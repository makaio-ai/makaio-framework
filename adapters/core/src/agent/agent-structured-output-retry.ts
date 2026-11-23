import type { ResponseSchemaDescriptor, StructuredOutputValidationError } from '@makaio/contracts';
import {
  requireCompletedTurnText,
  TurnNotCompletedError,
  type MessageHandle,
  type MessageResult,
} from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { AgentStructuredOutputManager, ValidateTerminalResultOutput } from './agent-structured-output-manager.js';

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
 *
 * A retry that cannot run or does not complete rejects instead of yielding
 * empty output, so further retries and enforcement never treat a provider
 * failure as a fixable schema violation. The turn then ends with the retry's
 * terminal outcome (see {@link toRetryNotCompletedResult}) and still flows
 * through normal terminal-event delivery.
 * @param deps - Manager, connector accessor, and turn context
 * @returns Transform applied to the tracked terminal {@link MessageResult}
 */
export function createStructuredOutputTerminalTransform(
  deps: StructuredOutputTerminalTransformDeps,
): (result: MessageResult) => Promise<MessageResult> {
  const { structuredOutputManager, getConnector, sessionId, messageHandle, responseSchema } = deps;
  /**
   * Run one retry turn and resolve with its terminal result. Every way the
   * retry can end — no live connector, a rejected dispatch, or the turn's own
   * outcome — is a terminal result, so the caller reads it fail-closed in one
   * place instead of letting a dispatch rejection escape as a generic
   * transform failure that would keep the original turn `completed`.
   * @param attemptNumber - 1-based retry attempt number
   * @param validationErrors - Validation errors of the preceding attempt
   * @returns Terminal result of the retry turn
   */
  const runRetryTurn = async (
    attemptNumber: number,
    validationErrors: StructuredOutputValidationError[],
  ): Promise<MessageResult> => {
    const connector = getConnector();
    if (!connector) {
      return { outcome: 'error', error: new Error('Structured-output retry requires a live connector') };
    }
    let retryHandle: MessageHandle;
    try {
      // Internal retry emissions are provisional. SessionBridge persists
      // structured-output turns from the validated agent.complete.message
      // so invalid attempt blocks cannot be flushed as the assistant turn.
      retryHandle = await connector.sendMessage(messageHandle.message, {
        call: messageHandle.call,
        deliveryMode: 'enqueue',
        internalRetry: true,
        messageId: `${messageHandle.messageId}:structured-output-retry:${attemptNumber}`,
        messageHistory: messageHandle.messageHistory,
        responseSchema,
        requestCorrelation: messageHandle.requestCorrelation,
        turnContext: {
          ...messageHandle.turnContext,
          structuredOutputRetry: {
            attemptNumber,
            validationErrors,
            instruction: 'Previous output did not match the requested JSON schema. Respond only with corrected JSON.',
          },
        },
      });
    } catch (error) {
      return { outcome: 'error', error: error instanceof Error ? error : String(error) };
    }
    return retryHandle.waitForCompletion();
  };

  return async (result: MessageResult): Promise<MessageResult> => {
    if (result.outcome !== 'completed') return result;

    let validated: ValidateTerminalResultOutput;
    try {
      validated = await structuredOutputManager.validateTerminalResult(messageHandle.call, {
        responseSchema,
        message: result.result?.message,
        sessionId,
        retryTurn: async ({ attemptNumber, validationErrors }) =>
          requireCompletedTurnText(await runRetryTurn(attemptNumber, validationErrors)),
      });
    } catch (error) {
      if (error instanceof TurnNotCompletedError) return toRetryNotCompletedResult(error);
      throw error;
    }

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

/**
 * Terminal result of a structured-output turn whose retry did not complete.
 *
 * The retry was the turn's only remaining route to conforming output, so the
 * turn ends with the retry's terminal outcome and failure — an `error` keeps
 * the provider error (and its fallback category) for `agent.complete`
 * consumers, a cancellation stays a cancellation. The invalid first-attempt
 * output is dropped so no consumer persists it as the turn's answer.
 * @param error - Rejection carrying the retry turn's terminal result
 * @returns Canonical terminal result for the original turn
 */
function toRetryNotCompletedResult(error: TurnNotCompletedError): MessageResult {
  return {
    ...error.result,
    result: null,
    structuredOutputValidation: {
      status: 'failed',
      errors: [{ message: error.message, instancePath: '', schemaPath: '#' }],
    },
  };
}
