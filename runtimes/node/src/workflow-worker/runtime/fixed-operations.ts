import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  JsonRecordSchema,
  snapshotJsonBoundary,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { ExtensionNameSchema, localContributionName } from '@makaio/core';
import type { Launcher, OwnerLaunchOptions, OwnerQuiescence, ProcessOwner } from '@makaio/subprocess';
import { z } from 'zod';

export type FixedOperationPhase = 'workflow-source' | 'before-steps' | 'after-steps';
type FixedStepStatus = WorkflowRunResult['status'] | 'not-started';
type FixedOperationFacts = Readonly<Record<string, JsonValue>>;

export interface FixedOperationRunResult<T> {
  readonly result: T;
  readonly facts: ReadonlyMap<string, FixedOperationFacts>;
  readonly afterStepsErrors: readonly unknown[];
}

/** One operation's ports, already scoped to its run and owner. */
export interface FixedOperationContext {
  readonly declaration: JsonValue;
  readonly block: JsonValue | undefined;
  readonly facts: FixedOperationFacts;
  readonly workspace: string;
  readonly workflowRoot?: string;
  readonly quiescence?: OwnerQuiescence;
  /** Outcome of the step phase, including failure to initialize the step runner. */
  readonly stepStatus?: FixedStepStatus;
  readonly definitions: (kind: string, ids?: readonly string[]) => Promise<readonly JsonValue[]>;
  readonly launch: (request: Omit<OwnerLaunchOptions, 'owner' | 'signal'>) => ReturnType<Launcher['launch']>;
  readonly addresses: {
    readonly open: (purpose: string) => Promise<string>;
    readonly close: (purpose: string) => Promise<void>;
  };
  readonly signal: AbortSignal;
}

export interface FixedOperationContribution {
  readonly name: string;
  readonly phase: FixedOperationPhase;
  readonly applies: (declaration: JsonValue) => boolean;
  readonly run: (context: FixedOperationContext) => Promise<FixedOperationOutcome>;
}

const FixedOperationOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), facts: JsonRecordSchema, workflowRoot: z.string().optional() }),
  z.strictObject({ ok: z.literal(false), facts: JsonRecordSchema, detail: z.string() }),
]);

type FixedOperationOutcome = z.output<typeof FixedOperationOutcomeSchema>;

/** Fixed operations extracted from one verified extension by the worker loader. */
export interface FixedOperationExtension {
  readonly name: string;
  readonly fixedOperations: readonly FixedOperationContribution[];
}

export interface FixedWorkflowSource {
  readonly extension: string;
  readonly declaration: JsonValue;
  readonly block: JsonValue | undefined;
  readonly dependencies?: Readonly<Record<string, JsonValue>> & { readonly resolver: string };
}

export interface FixedOperationRun {
  readonly definition: Pick<WorkflowDefinition, 'extensions'>;
  readonly source?: FixedWorkflowSource;
  readonly blocks?: Readonly<Record<string, JsonValue>>;
  readonly workspace: string;
  readonly launcher: Launcher;
  /** Reader pinned to the workflow's definition revision by the caller. */
  readonly definitions: FixedOperationContext['definitions'];
  /** Bind mediated addresses to one operation, retiring them when the callback settles. */
  readonly withAddresses: <T>(
    operation: string,
    run: (addresses: FixedOperationContext['addresses']) => Promise<T>,
  ) => Promise<T>;
  readonly signal: AbortSignal;
  /** Controls cleanup independently of a request to cancel the steps. */
  readonly afterStepsSignal: AbortSignal;
}

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
  | 'process-closure-unconfirmed';

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

interface RegisteredOperation extends FixedOperationContribution {
  readonly extension: string;
}

/**
 * Validate and snapshot worker-local contributions in dependency order.
 * @param extensions - Verified extension exports in dependency order.
 * @returns A registry usable only on the runner side of the step boundary.
 */
export function registerFixedOperations(extensions: readonly FixedOperationExtension[]) {
  const names = new Set<string>();
  const sources = new Set<string>();
  const groups = new Map<string, RegisteredOperation[]>();
  for (const { name, fixedOperations } of extensions) {
    if (groups.has(name)) throw new FixedOperationError('invalid-registration', 'registration');
    groups.set(
      name,
      fixedOperations.map((operation) => validateRegistration(name, operation, names, sources)),
    );
  }
  return new FixedOperationRegistry([...groups.values()]);
}

/**
 * Admit a contribution only under the identity of its verified extension.
 * @param extension - Verified owner name.
 * @param operation - Contribution supplied by that owner.
 * @param names - Names already registered.
 * @param sources - Owners that already supply a source phase.
 * @returns A validated registration.
 */
function validateRegistration(
  extension: string,
  operation: FixedOperationContribution,
  names: Set<string>,
  sources: Set<string>,
): RegisteredOperation {
  const { name, phase, applies, run } = operation;
  if (!ExtensionNameSchema.safeParse(extension).success || typeof applies !== 'function' || typeof run !== 'function') {
    throw new FixedOperationError('invalid-registration', 'registration');
  }
  if (typeof name !== 'string' || localContributionName(extension, name) === undefined || name.endsWith('.')) {
    throw new FixedOperationError('foreign-owner', 'registration');
  }
  if (phase !== 'workflow-source' && phase !== 'before-steps' && phase !== 'after-steps') {
    throw new FixedOperationError('invalid-registration', 'registration');
  }
  if (names.has(name)) throw new FixedOperationError('duplicate-operation', 'registration');
  names.add(name);
  if (phase === 'workflow-source') {
    if (sources.has(extension)) throw new FixedOperationError('duplicate-source', 'registration');
    sources.add(extension);
  }
  return { extension, name, phase, applies, run };
}

type Invocation = Pick<
  FixedOperationContext,
  'declaration' | 'block' | 'workflowRoot' | 'quiescence' | 'stepStatus' | 'signal'
>;

/** Worker-local phase scheduler. Its invocation surface is limited to the three runner phases. */
class FixedOperationRegistry {
  /**
   * Create the registry from its validated groups.
   * @param groups - Registrations grouped by extension in dependency order.
   */
  public constructor(private readonly groups: readonly (readonly RegisteredOperation[])[]) {}

  /**
   * Provide the source and run the paired extension phases around step execution.
   * @param runtime - Inputs and scoped ports for one run.
   * @param runSteps - Execute with the prepared source root, when a source is declared.
   * @returns The step result and facts from the executed operations.
   * @typeParam T - Step runner result.
   */
  public async run<T extends Pick<WorkflowRunResult, 'status'>>(
    runtime: FixedOperationRun,
    runSteps: (workflowRoot: string | undefined) => Promise<T>,
  ): Promise<FixedOperationRunResult<T>> {
    const facts = new Map<string, FixedOperationFacts>();
    const prepared = new Set<string>();
    const invoke = this.bindInvocation(runtime, facts, prepared);
    let root: string | undefined;
    let stepStatus: FixedStepStatus = 'not-started';
    let execution: { result: T } | { error: unknown };
    try {
      await this.prepareSource(runtime, invoke, (preparedRoot) => {
        root = preparedRoot;
      });
      for (const [operation, invocation] of this.select('before-steps', runtime)) {
        assertOperationActive(runtime.signal, 'before-steps');
        if (operationApplies(operation, invocation.declaration)) {
          await invoke(operation, { ...invocation, signal: runtime.signal });
        }
      }
      assertOperationActive(runtime.signal, 'before-steps');
      stepStatus = 'failed';
      const result = await runSteps(root);
      stepStatus = result.status;
      execution = { result };
    } catch (error) {
      execution = { error };
    }

    const quiescence = await runtime.launcher.closeAll();
    const afterStepsErrors = await this.runAfterSteps(runtime, invoke, prepared, {
      stepStatus,
      quiescence,
      workflowRoot: root,
      signal: runtime.afterStepsSignal,
    });
    if ('result' in execution) return { result: execution.result, facts, afterStepsErrors };
    if (afterStepsErrors.length === 0) throw execution.error;
    throw new AggregateError([execution.error, ...afterStepsErrors], 'Workflow and follow-up operations failed', {
      cause: execution.error,
    });
  }

  /**
   * Attempt each eligible follow-up once in teardown order.
   * @param runtime - Declarations and blocks for the run.
   * @param invoke - Worker-owned invocation.
   * @param prepared - Owners whose source or preparation operation succeeded.
   * @param completion - Step disposition, closure evidence and cleanup signal.
   * @returns Errors in attempt order.
   */
  private async runAfterSteps(
    runtime: FixedOperationRun,
    invoke: InvokeOperation,
    prepared: ReadonlySet<string>,
    completion: Omit<Invocation, 'declaration' | 'block'>,
  ): Promise<readonly unknown[]> {
    const errors: unknown[] = [];
    for (const [operation, invocation] of this.select('after-steps', runtime, prepared)) {
      try {
        if (operationApplies(operation, invocation.declaration)) {
          await invoke(operation, { ...invocation, ...completion });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  /**
   * Run the explicit source provider, then its optional dependency resolver.
   * @param runtime - Source declaration and run cancellation signal.
   * @param invoke - Worker-owned invocation.
   * @param recordRoot - Retain the source root for follow-up even if dependency resolution fails.
   */
  private async prepareSource(
    runtime: FixedOperationRun,
    invoke: InvokeOperation,
    recordRoot: (root: string) => void,
  ): Promise<void> {
    const { source, signal } = runtime;
    if (source === undefined) return;
    assertOperationActive(signal, 'workflow-source');
    const providers = this.groups.flat().filter(({ phase }) => phase === 'workflow-source');
    const provider = providers.find(({ extension }) => extension === source.extension);
    if (provider === undefined) throw new FixedOperationError('missing-source', 'workflow-source');
    const declaration = ownValue(runtime.definition.extensions, provider.extension);
    const claimed = snapshotJsonBoundary(source.declaration);
    const frozen = snapshotJsonBoundary(declaration);
    if (declaration === undefined || !claimed.ok || !frozen.ok || !isDeepStrictEqual(claimed.value, frozen.value)) {
      throw new FixedOperationError('source-declaration-mismatch', 'workflow-source');
    }
    const dependencies = source.dependencies;
    const resolver = dependencies && providers.find(({ name }) => name === dependencies.resolver);
    if (dependencies !== undefined && (resolver === undefined || resolver.extension === provider.extension)) {
      throw new FixedOperationError('invalid-resolver', 'workflow-source');
    }
    const root = await invoke(provider, { declaration, block: source.block, signal });
    if (root === undefined || !isAbsolute(root)) {
      throw new FixedOperationError('missing-source-root', 'workflow-source');
    }
    recordRoot(root);
    if (resolver !== undefined && dependencies !== undefined) {
      await invoke(resolver, { declaration: dependencies, block: undefined, workflowRoot: root, signal });
    }
  }

  /**
   * Select declared operations in phase order before evaluating their predicates.
   * @param phase - Phase to select.
   * @param runtime - Declarations and order blocks for the run.
   * @param prepared - Owners that successfully prepared, required in the after phase.
   * @returns Operations with only their own declaration and block.
   */
  private *select(
    phase: 'before-steps' | 'after-steps',
    runtime: FixedOperationRun,
    prepared?: ReadonlySet<string>,
  ): Generator<[RegisteredOperation, Pick<Invocation, 'declaration' | 'block'>]> {
    const { extensions } = runtime.definition;
    if (extensions === undefined) return;
    const ordered = phase === 'after-steps' ? this.groups.toReversed() : this.groups;
    for (const operation of ordered.flat()) {
      const { extension } = operation;
      if (operation.phase !== phase || (prepared !== undefined && !prepared.has(extension))) continue;
      const declaration = ownValue(extensions, extension);
      if (declaration === undefined) continue;
      yield [operation, { declaration, block: ownValue(runtime.blocks, extension) }];
    }
  }

  /**
   * Bind invocation authority and per-run facts at the runner boundary.
   * @param runtime - Launcher and mediated ports.
   * @param facts - Facts grouped by contributing extension.
   * @param prepared - Owners with a successful source or preparation operation.
   * @returns A function callable only by the scheduler.
   */
  private bindInvocation(
    runtime: FixedOperationRun,
    facts: Map<string, FixedOperationFacts>,
    prepared: Set<string>,
  ): InvokeOperation {
    return async (operation, invocation) => {
      const { name, phase, extension } = operation;
      const { signal, ...data } = invocation;
      assertOperationActive(signal, phase);
      const owner: ProcessOwner = { kind: 'runtime', operation: name };
      return runtime.withAddresses(name, async (addresses) => {
        const outcome = await runOperation(
          operation,
          {
            ...structuredClone(data),
            signal,
            facts: structuredClone(facts.get(extension) ?? {}),
            workspace: runtime.workspace,
            definitions: async (kind, ids) => structuredClone(await runtime.definitions(kind, ids)),
            launch: (request) => runtime.launcher.launch({ ...request, owner, signal }),
            addresses,
          },
          runtime.launcher,
          owner,
          (result) => {
            facts.set(extension, { ...facts.get(extension), ...result.facts });
            if (result.ok && phase !== 'after-steps') prepared.add(extension);
          },
        );
        if (!outcome.ok) throw new FixedOperationError('operation-failed', phase, outcome.detail);
        return outcome.workflowRoot;
      });
    };
  }
}

/**
 * Read only an own JSON value from an extension-keyed record.
 * @param record - Per-extension value record.
 * @param name - Verified extension key.
 * @returns The owner's value when present.
 */
function ownValue(record: Readonly<Record<string, JsonValue>> | undefined, name: string): JsonValue | undefined {
  return record !== undefined && Object.hasOwn(record, name) ? record[name] : undefined;
}

type InvokeOperation = (operation: RegisteredOperation, invocation: Invocation) => Promise<string | undefined>;

/**
 * Evaluate selection against the owner's isolated declaration.
 * @param operation - Operation being selected.
 * @param declaration - The owner's declaration.
 * @returns Whether the operation applies.
 */
function operationApplies(operation: RegisteredOperation, declaration: JsonValue): boolean {
  try {
    return operation.applies(structuredClone(declaration));
  } catch {
    throw new FixedOperationError('operation-failed', operation.phase);
  }
}

/**
 * Reject a cancelled phase without exposing the caller's abort reason.
 * @param signal - Signal controlling this phase.
 * @param phase - Phase that would have run.
 */
function assertOperationActive(signal: AbortSignal, phase: FixedOperationPhase): void {
  if (signal.aborted) throw new FixedOperationError('operation-aborted', phase);
}

/**
 * Always close processes started by one invocation before the next phase can run.
 * @param operation - Selected operation.
 * @param context - Owner-bound capabilities and abort signal.
 * @param launcher - Shared worker-owned launcher.
 * @param owner - Owner of the operation's processes.
 * @param record - Record a settled outcome before cleanup can reject.
 * @returns The operation's outcome after process closure.
 */
async function runOperation(
  operation: RegisteredOperation,
  context: FixedOperationContext,
  launcher: Launcher,
  owner: ProcessOwner,
  record: (outcome: FixedOperationOutcome) => void,
): Promise<FixedOperationOutcome> {
  const outcome = await Promise.resolve()
    .then(() => operation.run(context))
    .then(
      (value) => {
        const snapshot = snapshotJsonBoundary(value);
        const parsed = snapshot.ok ? FixedOperationOutcomeSchema.safeParse(snapshot.value) : undefined;
        if (!parsed?.success) return new FixedOperationError('operation-failed', operation.phase);
        record(parsed.data);
        return parsed.data;
      },
      () => new FixedOperationError(context.signal.aborted ? 'operation-aborted' : 'operation-failed', operation.phase),
    );
  const evidence = await launcher.closeOwner(owner);
  if (evidence.kind !== 'quiescent') {
    throw new FixedOperationError('process-closure-unconfirmed', operation.phase);
  }
  if (outcome instanceof FixedOperationError) throw outcome;
  return outcome;
}
