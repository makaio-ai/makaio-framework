import { JsonRecordSchema, snapshotJsonBoundary, type JsonValue } from '@makaio/contracts';
import type {
  FixedOperationContext,
  FixedOperationContribution,
  FixedOperationOutcome,
  FixedOperationPhase,
} from '@makaio/contracts/extension';
import type { Launcher, ProcessOwner } from '@makaio/subprocess';
import { z } from 'zod';

export type FixedOperationFailure =
  | 'invalid-registration'
  | 'duplicate-operation'
  | 'duplicate-source'
  | 'foreign-owner'
  | 'missing-source'
  | 'source-declaration-mismatch'
  | 'invalid-resolver'
  | 'missing-source-root'
  | 'operation-failed'
  | 'operation-aborted'
  | 'process-closure-unconfirmed'
  | 'generation-retirement-unconfirmed'
  | 'inactive-registration';

export class FixedOperationError extends Error {
  /**
   * Construct a typed worker-local failure.
   * @param code - Stable failure reason.
   * @param phase - The rejected phase, or registration.
   * @param detail - Extension-defined failure code, when supplied by the operation.
   */
  public constructor(
    public readonly code: FixedOperationFailure,
    public readonly phase: FixedOperationPhase | 'registration',
    public readonly detail?: string,
  ) {
    super(`Fixed operation ${phase}: ${code}`);
    this.name = 'FixedOperationError';
  }
}

/**
 * Reject a cancelled phase without exposing the caller's abort reason.
 * @param signal - Signal controlling this phase.
 * @param phase - Phase that would have run.
 */
export function assertOperationActive(signal: AbortSignal, phase: FixedOperationPhase): void {
  if (signal.aborted) throw new FixedOperationError('operation-aborted', phase);
}

const FixedOperationOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), facts: JsonRecordSchema, workflowRoot: z.string().optional() }),
  z.strictObject({ ok: z.literal(false), facts: JsonRecordSchema, detail: z.string() }),
]);

/** Owns running callbacks until the extension coordinator can finish retiring this registration. */
export class FixedOperationGeneration {
  private readonly retirement = new AbortController();
  private readonly running = new Set<Promise<void>>();
  public readonly signal: AbortSignal;

  /**
   * Bind the registration to its coordinator-issued lifetime.
   * @param lifetime - Carrier lifetime for the activation.
   */
  public constructor(lifetime: AbortSignal) {
    this.signal = AbortSignal.any([lifetime, this.retirement.signal]);
  }

  /**
   * Track callback settlement, including process closure, without consuming its outcome.
   * @param work - In-flight operation invocation.
   */
  public track(work: Promise<FixedOperationOutcome>): void {
    const settled = (): void => {
      this.running.delete(completion);
    };
    const completion = work.then(settled, settled);
    this.running.add(completion);
  }

  /** Withdraw authority immediately and wait for admitted callbacks to settle. */
  public async retire(): Promise<void> {
    this.retirement.abort();
    await Promise.all(this.running);
  }
}

/**
 * Evaluate selection against the owner's isolated declaration.
 * @param operation - Operation being selected.
 * @param declaration - The owner's declaration.
 * @returns Whether the operation applies.
 */
export function operationApplies(operation: FixedOperationContribution, declaration: JsonValue): boolean {
  try {
    const applies: unknown = operation.applies(structuredClone(declaration));
    if (typeof applies === 'boolean') return applies;
    void Promise.resolve(applies).catch(() => undefined);
  } catch {
    throw new FixedOperationError('operation-failed', operation.phase);
  }
  throw new FixedOperationError('invalid-registration', operation.phase);
}

/**
 * Always close processes started by one invocation before the next phase can run.
 * @param operation - Selected operation.
 * @param context - Owner-bound capabilities and abort signal.
 * @param launcher - Shared worker-owned launcher.
 * @param owner - Owner of the operation's processes.
 * @param assertActive - Recheck authority immediately before running the contribution.
 * @param generation - Retirement signal for the selected registrations.
 * @returns The operation's outcome after process closure.
 */
export async function runOperation(
  operation: FixedOperationContribution,
  context: FixedOperationContext,
  launcher: Launcher,
  owner: ProcessOwner,
  assertActive: () => void,
  generation: AbortSignal,
): Promise<FixedOperationOutcome> {
  const work = Promise.resolve().then(() => {
    assertActive();
    return operation.run(context);
  });
  const outcome = await work.then(
    (value) => {
      if (generation.aborted) return new FixedOperationError('inactive-registration', operation.phase);
      const snapshot = snapshotJsonBoundary(value);
      const parsed = snapshot.ok ? FixedOperationOutcomeSchema.safeParse(snapshot.value) : undefined;
      if (!parsed?.success) return new FixedOperationError('operation-failed', operation.phase);
      return parsed.data;
    },
    (error: unknown) =>
      generation.aborted || (error instanceof FixedOperationError && error.code === 'inactive-registration')
        ? new FixedOperationError('inactive-registration', operation.phase)
        : new FixedOperationError(context.signal.aborted ? 'operation-aborted' : 'operation-failed', operation.phase),
  );
  const evidence = await launcher.closeOwner(owner);
  if (evidence.kind !== 'quiescent') {
    throw new FixedOperationError('process-closure-unconfirmed', operation.phase);
  }
  if (outcome instanceof FixedOperationError) throw outcome;
  return outcome;
}
