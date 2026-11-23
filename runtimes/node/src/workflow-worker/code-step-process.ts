import { isDeepStrictEqual } from 'node:util';
import { snapshotJsonBoundary } from '@makaio/contracts/shared';
import { StepRunResultSchema, StepTelemetrySchema, type StepRunResult } from '@makaio/contracts';
import {
  createJsonRpcClient,
  type Launcher,
  type SiteProcessOutcome,
  type OwnerLaunchOptions,
  type ProcessOwner,
} from '@makaio/subprocess';
import { z } from 'zod';
import { bindCodeStepResultChannel } from './code-step-result-channel.js';

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

const SubmissionSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.literal('output.submit'),
  params: StepRunResultSchema.strict()
    .extend({ telemetry: StepTelemetrySchema.strict() })
    .refine((result) => result.status === 'failed' || result.output !== undefined),
});

type ProcessFacts = SiteProcessOutcome;
type ResultFailure = 'no-output' | 'invalid-output' | 'conflicting-output' | 'process-exit';

/** A code step invocation resolved by the worker, under the policy of this step owner. */
export interface LocalCodeStepInvocation extends Omit<OwnerLaunchOptions, 'owner' | 'output' | 'stdin'> {
  readonly owner: Extract<ProcessOwner, { kind: 'step' }>;
}

/** The accepted child result or the reason the process did not supply it. */
export type CodeStepProcessResult =
  | { readonly kind: 'reported'; readonly result: StepRunResult; readonly process: ProcessFacts }
  | { readonly kind: 'cancelled' | 'timed-out'; readonly process: ProcessFacts }
  | { readonly kind: 'process-failed'; readonly reason: ResultFailure; readonly process: ProcessFacts };

/** Accepts one immutable result and acknowledges identical retries. */
class StepResultReceiver {
  public constructor(private readonly stop: () => void) {}

  public result?: StepRunResult;
  public failure?: ResultFailure;

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
}

/**
 * Classify a process and its typed submission, keeping cancellation and stop evidence.
 * @param process - Final process facts, excluding raw output.
 * @param receiver - Submission seen during the invocation.
 * @param validFraming - Whether the step sent a complete framed transcript.
 * @returns Final code step outcome.
 */
function outcome(process: ProcessFacts, receiver: StepResultReceiver, validFraming: boolean): CodeStepProcessResult {
  if (process.status === 'cancelled' || process.status === 'timed-out') {
    return { kind: process.status, process };
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
  const { error: _error, ...result } = receiver.result;
  return {
    kind: 'reported',
    result: result.status === 'failed' ? { ...result, error: 'Code step reported a failure' } : result,
    process,
  };
}

/**
 * Run a worker-selected code step entry point and accept its JSON-RPC result over local pipes.
 * The launcher passes the explicit environment and does not supply bus credentials or a connection.
 * The execution site determines which other resources a child can reach.
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
  if (channel !== undefined) createJsonRpcClient(channel).onServerRequest(receiver.accept);
  const { output: _output, ...process } = await child.result;
  await channel?.ended;
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
  return outcome(process, receiver, channel?.validFraming ?? false);
}
