import type { JsonValue } from '../shared/json-value.js';
import type {
  CodeStepData,
  CodeStepLaunchInput,
  CodeStepLaunchResult,
  CodeStepRequestInput,
  CodeStepRequestResult,
} from './code-step-context.js';
import type { WorkflowProgressUpdate } from './namespace.js';

// ─────────────────────────────────────────────────────────────
// Previous Step Output Types
// ─────────────────────────────────────────────────────────────

type SerializedPreviousStep = CodeStepData['previousSteps'][string];

/**
 * The shape of a declared predecessor entry in `ctx.previousSteps`.
 *
 * Predecessors can be completed or skipped. Both remain visible so downstream
 * functions can branch on the terminal status of every declared predecessor.
 * @typeParam TOutput - The code step's inferred output type
 */
export type PreviousStepOutput<TOutput extends JsonValue> = Readonly<
  | (Omit<Extract<SerializedPreviousStep, { status: 'completed' }>, 'output'> & { output: TOutput })
  | (Extract<SerializedPreviousStep, { status: 'skipped' }> & { output?: undefined })
>;

// ─────────────────────────────────────────────────────────────
// Progress Update
// ─────────────────────────────────────────────────────────────

export type { WorkflowProgressUpdate };

// ─────────────────────────────────────────────────────────────
// Step Context
// ─────────────────────────────────────────────────────────────

/** The data and mediated capabilities available to an authored Code Step on either execution path. */
export interface StepContext extends Omit<Readonly<CodeStepData>, 'previousSteps'> {
  /** Results of previous steps in the current execution scope. */
  readonly previousSteps: Readonly<Record<string, PreviousStepOutput<JsonValue>>>;

  /** Cooperative cancellation for this invocation when its execution site can notify the handler. */
  readonly signal: AbortSignal;

  /**
   * Send a request through the runtime's registered subject boundary.
   * A caller-local worker thread can use its existing host connection for a
   * subject absent from its local registry. It accepts the reply as JSON.
   * @param input - Subject and JSON payload.
   * @returns The response or a typed refusal.
   */
  request(input: CodeStepRequestInput): Promise<CodeStepRequestResult>;

  /**
   * Start a process under the runtime's ownership and execution policy.
   * @param input - Program, arguments, relative working directory and input mode.
   * @returns A portable process handle or a typed refusal.
   */
  launchProcess(input: CodeStepLaunchInput): Promise<CodeStepLaunchResult>;
}

/** Handler that receives the same restricted context in the caller and in a step process. */
export type CodeStepHandler = (context: StepContext) => JsonValue | Promise<JsonValue>;

/** Code Step handler invoked for each item in an iterate node. */
export type IterateHandler = CodeStepHandler;
