import { isDeepStrictEqual } from 'node:util';
import { snapshotJsonBoundary } from '@makaio/contracts/shared';
import { CODE_STEP_INVALID_REQUEST, CODE_STEP_REQUEST_REJECTED, StepTelemetrySchema } from '@makaio/contracts';
import {
  createJsonRpcClient,
  type Launcher,
  type SiteProcessOutcome,
  type OwnerLaunchOptions,
  type ProcessOwner,
} from '@makaio/subprocess';
import { abortableWait } from '@makaio/utils';
import { z } from 'zod';
import { bindCodeStepResultChannel } from './code-step-result-channel.js';
import {
  AgentStepProcessFailureSchema,
  LocalModelAddressSchema,
  type AgentStepProcessInput,
} from './agent-step/protocol.js';
import {
  CheckoutCodeStepFailureSchema,
  StepProcessResultSchema,
  type StepProcessResult,
  STEP_METHOD_NOT_SUPPORTED,
  StepProcessLaunchRefusalSchema,
  StepProcessLaunchRequestSchema,
  StepRequestCallRequestSchema,
  type CheckoutCodeStepInput,
} from './step-interface-schemas.js';

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

const SubmissionSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.literal('output.submit'),
  params: StepProcessResultSchema.strict()
    .extend({ telemetry: StepTelemetrySchema.strict() })
    .refine((result) => result.status !== 'completed' || result.output !== undefined),
});

type ProcessFacts = SiteProcessOutcome;
type ResultFailure = 'no-output' | 'invalid-output' | 'conflicting-output' | 'process-exit' | 'refusal-observer-failed';

/** A code step invocation resolved by the worker, under the policy of this step owner. */
export interface LocalCodeStepInvocation extends Omit<OwnerLaunchOptions, 'owner' | 'output' | 'stdin'> {
  readonly owner: Extract<ProcessOwner, { kind: 'step' }>;
}

/** Input and observer for the internal checkout process channel. */
export interface CheckoutStepExchange {
  readonly input: CheckoutCodeStepInput;
  readonly onRequestRefused: (subject: string, reason: 'request-not-granted') => void | Promise<void>;
}

type StepProcessExchange = CheckoutStepExchange | { readonly kind: 'agent'; readonly input: AgentStepProcessInput };

/** The accepted child result or the reason the process did not supply it. */
export type CodeStepProcessResult =
  | { readonly kind: 'reported'; readonly result: StepProcessResult; readonly process: ProcessFacts }
  | { readonly kind: 'cancelled' | 'timed-out'; readonly process: ProcessFacts }
  | { readonly kind: 'process-failed'; readonly reason: ResultFailure; readonly process: ProcessFacts };

/** Accepts one immutable result and acknowledges identical retries. */
class StepResultReceiver {
  public constructor(private readonly stop: () => void) {}

  private readonly observations = new Set<Promise<void>>();
  private refusalFailed = false;

  public result?: StepProcessResult;
  public failure?: ResultFailure;

  public get refusalUnobserved(): boolean {
    return this.refusalFailed || this.observations.size !== 0;
  }

  /**
   * Report unconfirmed refusals when owner cancellation takes precedence over the step result.
   * @param signal - Cancellation from the invocation owner.
   */
  public warnOnAbortedRefusals(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true && this.refusalUnobserved) {
      console.warn('[workflow-worker] requestRefusalObserverFailed');
    }
  }

  public accept = async (request: unknown): Promise<{ readonly accepted: true }> => {
    const snapshot = snapshotJsonBoundary(request);
    const parsed = snapshot.ok ? SubmissionSchema.safeParse(snapshot.value) : undefined;
    if (parsed?.success !== true) {
      this.failure ??= 'invalid-output';
      this.stop();
      throw new Error('Invalid code step result submission');
    }
    const result = parsed.data.params;
    if (this.result !== undefined && !isDeepStrictEqual(this.result, result)) {
      this.failure ??= 'conflicting-output';
      this.stop();
      throw new Error('Code step result differs from the first submission');
    }
    this.result ??= result;
    return { accepted: true };
  };

  /**
   * Record an observation even when the child does not await the response.
   * @param publish - Worker-owned refusal observer.
   * @returns The refusal after observation.
   */
  public async observeRefusal(
    publish: () => void | Promise<void>,
  ): Promise<{ ok: false; code: 'request-not-granted' }> {
    const observed = Promise.resolve()
      .then(publish)
      .catch(() => {
        this.refusalFailed = true;
        this.failure ??= 'refusal-observer-failed';
        this.stop();
        throw new Error('Step request refusal could not be observed');
      });
    this.observations.add(observed);
    try {
      await observed;
    } finally {
      this.observations.delete(observed);
    }
    return { ok: false, code: 'request-not-granted' };
  }

  /**
   * Wait for admitted observations within the original step deadline.
   * @param deadline - End of the launch budget on the monotonic clock.
   * @param signal - Cancellation from the invocation owner.
   */
  public async drainRefusals(deadline: number, signal: AbortSignal | undefined): Promise<void> {
    if (this.observations.size === 0) return;
    const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
    const timeout = AbortSignal.timeout(remaining);
    const wait = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      await abortableWait(Promise.allSettled(this.observations), wait);
    } catch {
      this.refusalFailed = true;
      this.failure ??= 'refusal-observer-failed';
    }
  }
}

/**
 * Classify a process and its typed submission, keeping cancellation and stop evidence.
 * @param process - Final process facts, excluding raw output.
 * @param receiver - Submission seen during the invocation.
 * @param validFraming - Whether the step sent a complete framed transcript.
 * @param exchange - The exchange assigned by the worker for this invocation.
 * @returns Final code step outcome.
 */
function outcome(
  process: ProcessFacts,
  receiver: StepResultReceiver,
  validFraming: boolean,
  exchange: StepProcessExchange | undefined,
): CodeStepProcessResult {
  if (process.status === 'cancelled' || process.status === 'timed-out') {
    return receiver.refusalUnobserved
      ? { kind: 'process-failed', reason: 'refusal-observer-failed', process }
      : { kind: process.status, process };
  }
  if (process.status === 'stop-failed' || process.status === 'spawn-failed' || process.status === 'output-limit') {
    return { kind: 'process-failed', reason: 'process-exit', process };
  }
  if (receiver.failure !== undefined || !validFraming) {
    return { kind: 'process-failed', reason: receiver.failure ?? 'invalid-output', process };
  }
  if (process.status !== 'completed' || process.containment?.kind !== 'quiescent') {
    return { kind: 'process-failed', reason: 'process-exit', process };
  }
  if (receiver.result === undefined) return { kind: 'process-failed', reason: 'no-output', process };
  const { error, ...result } = receiver.result;
  return {
    kind: 'reported',
    result:
      result.status === 'failed'
        ? {
            ...result,
            error: sanitizeReportedFailure(error, exchange),
          }
        : result,
    process,
  };
}

/**
 * Keep only failure codes from the process's assigned protocol.
 * @param error - Untrusted diagnostic supplied by the process.
 * @param exchange - The exchange assigned by the worker for this invocation.
 * @returns A fixed diagnostic without process-supplied text.
 */
function sanitizeReportedFailure(error: string | undefined, exchange: StepProcessExchange | undefined): string {
  if (exchange !== undefined && 'kind' in exchange) {
    const code = AgentStepProcessFailureSchema.safeParse(error);
    return code.success ? code.data : 'agent-turn-failed';
  }
  return (
    (exchange === undefined ? undefined : CheckoutCodeStepFailureSchema.safeParse(error).data) ??
    'Code step reported a failure'
  );
}

/**
 * Run a worker-selected code step entry point and accept its JSON-RPC result over local pipes.
 * The launcher passes the explicit environment and does not supply bus credentials or a connection.
 * The execution site determines which other resources a child can reach.
 * Child output and RPC share the existing byte budget. Redirected checkout
 * diagnostics do not become part of the Step Runner result.
 * The first stop trigger determines the outcome unless containment remains unproven,
 * in which case stop failure takes precedence.
 * @param launcher - The launcher that owns the step execution at its execution site.
 * @param invocation - Worker-resolved command and bounds for this step.
 * @returns The typed outcome, settled with the process result.
 */
export async function runLocalCodeStep(
  launcher: Launcher,
  invocation: LocalCodeStepInvocation,
): Promise<CodeStepProcessResult> {
  return runCodeStepProcess(launcher, invocation);
}

/**
 * Start an isolated agent turn with its scoped model lease as its only supplied environment entry.
 * @param launcher - Step execution site.
 * @param invocation - Trusted process command, owner, and bounds.
 * @param input - Data for the adapter turn.
 * @param modelAddress - Address of the worker-owned model lease.
 * @returns Terminal process result.
 */
export async function runAgentStepProcess(
  launcher: Launcher,
  invocation: Omit<LocalCodeStepInvocation, 'env'>,
  input: AgentStepProcessInput,
  modelAddress: string,
): Promise<CodeStepProcessResult> {
  if (!LocalModelAddressSchema.safeParse(modelAddress).success) throw new Error('Invalid agent model lease address');
  return runCodeStepProcess(
    launcher,
    { ...invocation, env: { MAKAIO_MODEL_ADDRESS: modelAddress } },
    { kind: 'agent', input },
  );
}

/**
 * Handle a request under the protocol the worker assigned to the child.
 * @param receiver - Owner of accepted results and observed refusals.
 * @param exchange - Worker-assigned exchange, if any.
 * @param request - Raw request from the child.
 * @returns The correlated response.
 */
async function receiveStepRequest(
  receiver: StepResultReceiver,
  exchange: StepProcessExchange | undefined,
  request: unknown,
) {
  if (exchange === undefined || typeof request !== 'object' || request === null || !('method' in request)) {
    return receiver.accept(request);
  }
  if (request.method === 'output.submit') return receiver.accept(request);
  if ('kind' in exchange) return { ok: false, code: STEP_METHOD_NOT_SUPPORTED };
  if (request.method === 'request.call') {
    const call = StepRequestCallRequestSchema.safeParse(request);
    if (!call.success) return { ok: false, code: CODE_STEP_REQUEST_REJECTED };
    return receiver.observeRefusal(() => exchange.onRequestRefused(call.data.params.subject, 'request-not-granted'));
  }
  if (request.method === 'process.launch') {
    const launch = StepProcessLaunchRequestSchema.safeParse(request);
    return StepProcessLaunchRefusalSchema.parse({
      ok: false,
      code: launch.success ? 'site-unreachable' : CODE_STEP_INVALID_REQUEST,
    });
  }
  return { ok: false, code: STEP_METHOD_NOT_SUPPORTED };
}

/**
 * Run the shared process channel after the worker's launch checks have succeeded.
 * @param launcher - Step execution site.
 * @param invocation - Trusted launch options.
 * @param exchange - Data and operations assigned by the trusted step starter, if any.
 * @returns Terminal process result.
 */
export async function runCodeStepProcess(
  launcher: Launcher,
  invocation: LocalCodeStepInvocation,
  exchange?: StepProcessExchange,
): Promise<CodeStepProcessResult> {
  const deadline = performance.now() + invocation.timeoutMs;
  const stop = new AbortController();
  const signal = invocation.signal === undefined ? stop.signal : AbortSignal.any([invocation.signal, stop.signal]);
  const child = launcher.launch({
    ...invocation,
    stdin: 'pipe',
    signal,
    output: { kind: 'capture', limitBytes: OUTPUT_LIMIT_BYTES },
  });
  const receiver = new StepResultReceiver(() => stop.abort());
  const { stdin, stdout } = child;
  const channel =
    stdin === undefined || stdout === undefined
      ? undefined
      : bindCodeStepResultChannel({ result: child.result, stdin, stdout }, stop, OUTPUT_LIMIT_BYTES);
  if (channel !== undefined) {
    createJsonRpcClient(channel).onServerRequest((request) => receiveStepRequest(receiver, exchange, request));
    if (exchange !== undefined) channel.send(exchange.input);
  }
  const { output: _output, ...process } = await child.result;
  await channel?.ended;
  // A completed child can leave outstanding requests behind. Stdout drain
  // guarantees that the receiver already knows about every admitted observation.
  if (process.status === 'completed') await receiver.drainRefusals(deadline, invocation.signal);
  receiver.warnOnAbortedRefusals(invocation.signal);
  const internalFailure = receiver.failure ?? (channel?.rejectedFraming ? 'invalid-output' : undefined);
  if (
    process.status === 'cancelled' &&
    process.cancellationSource === 'request' &&
    signal.aborted &&
    signal.reason === stop.signal.reason &&
    internalFailure !== undefined
  ) {
    return { kind: 'process-failed', reason: internalFailure, process };
  }
  return outcome(process, receiver, channel?.validFraming ?? false, exchange);
}
