import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  snapshotJsonBoundary,
  WorkflowError,
  WorkflowErrorCode,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowRunResult,
} from '@makaio/contracts';
import type {
  FixedOperationContext,
  FixedOperationContribution,
  FixedOperationFacts,
  FixedOperationOutcome,
} from '@makaio/contracts/extension';
import type { Launcher, ProcessOwner } from '@makaio/subprocess';
import { deepFreeze } from '@makaio/utils';
import type { CheckoutWorkflowSource } from '../checkout-workflow-reader.js';
import {
  assertOperationActive,
  FixedOperationError,
  FixedOperationGeneration,
  operationApplies,
  runOperation,
} from './fixed-operation-invocation.js';
import {
  FixedOperationAdmissions,
  validateRegistration,
  type FixedOperationAdmission,
  type FixedOperationCatalog,
  type RegisteredOperation,
} from './fixed-operation-registration.js';

export type { FixedOperationCatalogEntry } from './fixed-operation-registration.js';
export { FixedOperationError, type FixedOperationFailure } from './fixed-operation-invocation.js';

export type { FixedOperationContribution } from '@makaio/contracts/extension';
type FixedStepStatus = NonNullable<FixedOperationContext['stepStatus']>;
type RunFixedSteps<T> = (source: VerifiedFixedWorkflowSource | undefined, assertActive: () => void) => Promise<T>;

/** Canonical checkout and file verified against the admitted identity and revision. */
export type VerifiedFixedWorkflowSource = NonNullable<FixedOperationContext['verifiedSource']> &
  CheckoutWorkflowSource & { readonly verifiedPath: string };

export interface FixedOperationRunResult<T> {
  readonly result: T;
  readonly facts: ReadonlyMap<string, FixedOperationFacts>;
  readonly afterStepsErrors: readonly unknown[];
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
  readonly sourceDirectory: string;
  readonly verifySource: (root: string, signal: AbortSignal) => Promise<VerifiedFixedWorkflowSource>;
  readonly reverifySource: (source: VerifiedFixedWorkflowSource, signal: AbortSignal) => Promise<void>;
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

type Invocation = Pick<FixedOperationContext, 'declaration' | 'block' | 'quiescence' | 'stepStatus' | 'signal'> & {
  readonly verifiedSource?: VerifiedFixedWorkflowSource;
};

/** Worker-local phase scheduler. Its invocation surface is limited to the three runner phases. */
export class FixedOperationRegistry {
  private readonly active = new Map<string, readonly RegisteredOperation[]>();
  private readonly admissions = new FixedOperationAdmissions();

  /**
   * Use the coordinator's dependency order across activations.
   * @param dependencyOrder - Loaded extension names in stable dependency order.
   */
  public constructor(private readonly dependencyOrder: () => readonly string[]) {}

  /**
   * Publish one activation atomically after validating the complete batch.
   * @param owner - Owner supplied by the extension coordinator.
   * @param contributions - Contributions from the activation.
   * @param generation - Lifetime issued by the extension coordinator.
   * @param isActivated - Whether the coordinator completed activation.
   * @returns Withdrawal scoped to this activation's identity.
   */
  public activate(
    owner: string,
    contributions: readonly FixedOperationContribution[],
    generation: AbortSignal,
    isActivated: () => boolean,
  ): () => Promise<void> {
    if (generation.aborted || this.active.has(owner))
      throw new FixedOperationError('invalid-registration', 'registration');
    const names = new Set([...this.active.values()].flat().map(({ name }) => name));
    const lifetime = new FixedOperationGeneration(generation);
    const isActive = (): boolean => !lifetime.signal.aborted && isActivated();
    const sources = new Set<string>();
    const group = Object.freeze(
      contributions.map((entry) =>
        Object.freeze({ ...validateRegistration(owner, entry, names, sources), isActive, generation: lifetime }),
      ),
    );
    this.active.set(owner, group);
    return () => {
      if (this.active.get(owner) === group) this.active.delete(owner);
      return lifetime.retire();
    };
  }

  /**
   * Project the current registrations for a workflow load check.
   * @returns Immutable operation metadata and a single-use admission token.
   */
  public catalog(): FixedOperationCatalog {
    return this.admissions.capture(this.groups);
  }

  private get groups(): readonly (readonly RegisteredOperation[])[] {
    return this.dependencyOrder().flatMap((owner) => {
      const group = this.active.get(owner);
      return group?.[0]?.isActive() === true ? [group] : [];
    });
  }

  /**
   * Check the registration identity immediately before using its authority.
   * @param operations - The original registrations needed for the effect.
   */
  private assertRegistered(operations: Iterable<RegisteredOperation>): void {
    for (const operation of operations) {
      if (!operation.isActive() || !this.active.get(operation.extension)?.includes(operation)) {
        throw new FixedOperationError('inactive-registration', operation.phase);
      }
    }
  }

  /**
   * Verify and pin operation identities before setup can suspend the invocation.
   * @param admission - Single-use snapshot from the load check, if supplied.
   * @returns A scheduler bound to the admitted activation identities.
   */
  public bindRun(admission?: FixedOperationAdmission) {
    const groups = admission === undefined ? this.groups : this.admissions.consume(admission);
    this.assertRegistered(groups.flat());
    return <T extends Pick<WorkflowRunResult, 'status'>>(
      input: FixedOperationRun,
      runSteps: RunFixedSteps<T>,
    ): Promise<FixedOperationRunResult<T>> => this.run(groups, input, runSteps);
  }

  /**
   * Provide the source and run the paired extension phases around step execution.
   * @param groups - Registrations selected for this run.
   * @param input - Inputs and scoped ports for one run.
   * @param runSteps - Execute with the verified checkout, when a source is declared.
   * @returns The step result and facts from the executed operations.
   * @typeParam T - Step runner result.
   */
  private async run<T extends Pick<WorkflowRunResult, 'status'>>(
    groups: readonly (readonly RegisteredOperation[])[],
    input: FixedOperationRun,
    runSteps: RunFixedSteps<T>,
  ): Promise<FixedOperationRunResult<T>> {
    const runtime = snapshotRun(input);
    const facts = new Map<string, FixedOperationFacts>();
    const prepared = new Set<string>();
    const sourceOwners = new Set<RegisteredOperation>();
    const invoke = this.bindInvocation(runtime, facts);
    const accept: AcceptOperation = (operation, outcome, dependencies = sourceOwners) => {
      // A successful preparation with confirmed closure can still need independent cleanup.
      if (outcome.ok && operation.phase !== 'after-steps') prepared.add(operation.extension);
      this.assertRegistered([operation, ...dependencies]);
      facts.set(operation.extension, { ...facts.get(operation.extension), ...outcome.facts });
      if (!outcome.ok) throw new FixedOperationError('operation-failed', operation.phase, outcome.detail);
    };
    const used = new Set<RegisteredOperation>();
    let verified: VerifiedFixedWorkflowSource | undefined;
    let stepStatus: FixedStepStatus = 'not-started';
    let execution: { result: T } | { error: unknown };
    try {
      const source = this.selectSource(groups, runtime);
      const before = this.candidates(groups, 'before-steps', runtime).filter((entry) => this.applies(entry));
      if (source !== undefined) {
        const { resolver, dependencies } = source;
        sourceOwners.add(source.provider);
        if (resolver !== undefined) sourceOwners.add(resolver);
        const { checked, outcome } = await this.prepareSource(source, runtime, invoke, sourceOwners);
        accept(source.provider, outcome);
        verified = checked;
        if (resolver !== undefined && dependencies !== undefined) {
          const resolution = await invoke(
            resolver,
            {
              declaration: dependencies,
              block: undefined,
              signal: runtime.signal,
              verifiedSource: verified,
            },
            sourceOwners,
          );
          accept(resolver, resolution);
        }
      }
      for (const [operation, invocation] of before) {
        const outcome = await invoke(operation, { ...invocation, signal: runtime.signal }, sourceOwners);
        accept(operation, outcome);
        used.add(operation);
      }
      assertOperationActive(runtime.signal, 'before-steps');
      const assertActive = (): void => this.assertRegistered([...sourceOwners, ...used]);
      assertActive();
      stepStatus = 'failed';
      const result = await runSteps(verified, assertActive);
      stepStatus = result.status;
      execution = { result };
    } catch (error) {
      if (error instanceof WorkflowError && error.code === WorkflowErrorCode.SOURCE_MISMATCH) verified = undefined;
      execution = { error };
    }

    const afterStepsErrors = await this.runAfterSteps(groups, runtime, invoke, accept, prepared, sourceOwners, {
      stepStatus,
      verifiedSource: verified,
      signal: runtime.afterStepsSignal,
    }).catch((error: unknown) => [error]);
    // Returning the step result grants no further authority to its registrations.
    if ('result' in execution) return { result: execution.result, facts, afterStepsErrors };
    if (afterStepsErrors.length === 0) throw execution.error;
    throw new AggregateError([execution.error, ...afterStepsErrors], 'Workflow and follow-up operations failed', {
      cause: execution.error,
    });
  }

  /**
   * Evaluate all follow-up predicates before attempting each selected operation once in teardown order.
   * @param groups - Registrations selected for this run.
   * @param runtime - Declarations and blocks for the run.
   * @param invoke - Worker-owned invocation.
   * @param accept - Commit outcomes from active registrations.
   * @param prepared - Owners whose source or preparation operation succeeded.
   * @param sourceOwners - Registrations that authorize use of the verified checkout.
   * @param completion - Step disposition, remaining verified source and cleanup signal.
   * @returns Selection and invocation errors in teardown order.
   */
  private async runAfterSteps(
    groups: readonly (readonly RegisteredOperation[])[],
    runtime: FixedOperationRun,
    invoke: InvokeOperation,
    accept: AcceptOperation,
    prepared: ReadonlySet<string>,
    sourceOwners: ReadonlySet<RegisteredOperation>,
    completion: Omit<Invocation, 'declaration' | 'block' | 'quiescence'>,
  ): Promise<readonly unknown[]> {
    let quiescence = await runtime.launcher.closeAll();
    const selections = this.candidates(groups, 'after-steps', runtime, prepared).map((entry): FollowUpSelection => {
      try {
        return this.applies(entry) ? { entry } : undefined;
      } catch (error) {
        return { error };
      }
    });
    const sourceExtensions = new Set(Array.from(sourceOwners, ({ extension }) => extension));
    const independentOfSource = new Set<RegisteredOperation>();
    const errors: unknown[] = [];
    for (const selection of selections) {
      if (selection === undefined) continue;
      if ('error' in selection) {
        errors.push(selection.error);
        continue;
      }
      const [operation, invocation] = selection.entry;
      try {
        const sourceBound = operation.requiresVerifiedSource === true || sourceExtensions.has(operation.extension);
        const dependencies = sourceBound ? sourceOwners : independentOfSource;
        const verifiedSource = sourceBound ? completion.verifiedSource : undefined;
        if (sourceBound && verifiedSource === undefined) throw new FixedOperationError('missing-source', 'after-steps');
        if (sourceBound && quiescence.kind !== 'quiescent') {
          throw new FixedOperationError('process-closure-unconfirmed', 'after-steps');
        }
        const context = { ...invocation, ...completion, verifiedSource, quiescence };
        const outcome = await invoke(operation, context, dependencies);
        accept(operation, outcome, dependencies);
      } catch (error) {
        errors.push(error);
      }
      // Invocation closes its owner. The site folds that evidence into the run's closure verdict.
      quiescence = await runtime.launcher.closeAll();
    }
    return errors;
  }

  /**
   * Verify the proposed checkout before the provider's outcome can be committed.
   * @param source - Provider selected from the pinned registrations.
   * @param runtime - Run-local source verifier and cancellation.
   * @param invoke - Worker-owned invocation.
   * @param sourceOwners - Registrations that authorize this checkout and its resolver.
   * @returns Verified checkout and pending provider outcome.
   */
  private async prepareSource(
    source: SourceSelection,
    runtime: FixedOperationRun,
    invoke: InvokeOperation,
    sourceOwners: ReadonlySet<RegisteredOperation>,
  ): Promise<{ checked: VerifiedFixedWorkflowSource; outcome: FixedOperationOutcome }> {
    const outcome = await invoke(source.provider, source.invocation, sourceOwners);
    this.assertRegistered(sourceOwners);
    if (!outcome.ok) throw new FixedOperationError('operation-failed', 'workflow-source', outcome.detail);
    if (outcome.workflowRoot === undefined || !isAbsolute(outcome.workflowRoot)) {
      throw new FixedOperationError('missing-source-root', 'workflow-source');
    }
    const signal = AbortSignal.any([
      runtime.signal,
      ...Array.from(sourceOwners, ({ generation }) => generation.signal),
    ]);
    const checked = await runtime.verifySource(outcome.workflowRoot, signal).finally(() => {
      this.assertRegistered(sourceOwners);
    });
    return { checked, outcome };
  }

  /**
   * Validate the complete source phase before any source operation can run.
   * @param groups - Registrations selected for this run.
   * @param runtime - Source declaration and run cancellation signal.
   * @returns The selected provider and optional resolver.
   */
  private selectSource(
    groups: readonly (readonly RegisteredOperation[])[],
    runtime: FixedOperationRun,
  ): SourceSelection | undefined {
    const { source, signal } = runtime;
    if (source === undefined) return;
    assertOperationActive(signal, 'workflow-source');
    const providers = groups.flat().filter(({ phase }) => phase === 'workflow-source');
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
    if (
      dependencies !== undefined &&
      (resolver === undefined ||
        resolver.extension === provider.extension ||
        ownValue(runtime.definition.extensions, resolver.extension) === undefined)
    ) {
      throw new FixedOperationError('invalid-resolver', 'workflow-source');
    }
    this.assertRegistered([provider]);
    if (!operationApplies(provider, declaration)) throw new FixedOperationError('missing-source', 'workflow-source');
    if (resolver !== undefined) this.assertRegistered([resolver]);
    return { provider, resolver, dependencies, invocation: { declaration, block: source.block, signal } };
  }

  /**
   * Find declared candidates in execution order before consulting their predicates.
   * @param groups - Registrations selected for this run.
   * @param phase - Phase to select.
   * @param runtime - Declarations and order blocks for the run.
   * @param prepared - Owners that successfully prepared, required in the after phase.
   * @returns Candidate operations with only their own declaration and block.
   */
  private candidates(
    groups: readonly (readonly RegisteredOperation[])[],
    phase: 'before-steps' | 'after-steps',
    runtime: FixedOperationRun,
    prepared?: ReadonlySet<string>,
  ): SelectedOperation[] {
    const candidates: SelectedOperation[] = [];
    const ordered = phase === 'after-steps' ? groups.toReversed() : groups;
    for (const operation of ordered.flat()) {
      const { extension } = operation;
      if (operation.phase !== phase || (prepared !== undefined && !prepared.has(extension))) continue;
      const declaration = ownValue(runtime.definition.extensions, extension);
      if (declaration === undefined) continue;
      candidates.push([operation, { declaration, block: ownValue(runtime.blocks, extension) }]);
    }
    return candidates;
  }

  /**
   * Consult the predicate only while its registration is active.
   * @param candidate - Operation and its owner-scoped input.
   * @returns Whether the operation applies.
   */
  private applies([operation, { declaration }]: SelectedOperation): boolean {
    this.assertRegistered([operation]);
    return operationApplies(operation, declaration);
  }

  /**
   * Bind invocation authority and per-run facts at the runner boundary.
   * @param runtime - Launcher and mediated ports.
   * @param facts - Facts grouped by contributing extension.
   * @returns A function callable only by the scheduler.
   */
  private bindInvocation(runtime: FixedOperationRun, facts: Map<string, FixedOperationFacts>): InvokeOperation {
    return async (operation, invocation, dependencies) => {
      const { name, phase, extension } = operation;
      const { signal: phaseSignal, ...data } = invocation;
      const registrations = new Set([operation, ...dependencies]);
      const generations = new Set(Array.from(registrations, ({ generation }) => generation));
      const generation = AbortSignal.any(Array.from(generations, ({ signal }) => signal));
      const signal = AbortSignal.any([phaseSignal, generation]);
      const assertActive = (): void => {
        this.assertRegistered(registrations);
        assertOperationActive(signal, phase);
      };
      assertActive();
      if (phase === 'after-steps' && data.verifiedSource !== undefined) {
        // Recheck on rejection too, so cancellation is reported in the consuming phase.
        await runtime.reverifySource(data.verifiedSource, signal).finally(assertActive);
      }
      const owner: ProcessOwner = { kind: 'runtime', operation: name };
      return runtime.withAddresses(name, async (addresses) => {
        assertActive();
        const work = runOperation(
          operation,
          {
            ...data,
            signal,
            workflowRoot: data.verifiedSource?.checkoutRoot,
            facts: structuredClone(facts.get(extension) ?? {}),
            workspace: runtime.workspace,
            sourceDirectory: runtime.sourceDirectory,
            definitions: async (kind, ids) => {
              assertActive();
              const result = await runtime.definitions(kind, ids === undefined ? undefined : Object.freeze([...ids]));
              assertActive();
              return structuredClone(result);
            },
            launch: (request) => {
              assertActive();
              return runtime.launcher.launch({ ...request, owner, signal });
            },
            addresses: {
              open: async (purpose) => {
                assertActive();
                const address = await addresses.open(purpose);
                assertActive();
                return address;
              },
              close: (purpose) => addresses.close(purpose),
            },
          },
          runtime.launcher,
          owner,
          assertActive,
          generation,
        );
        for (const registration of generations) registration.track(work);
        return work;
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

type InvokeOperation = (
  operation: RegisteredOperation,
  invocation: Invocation,
  dependencies: ReadonlySet<RegisteredOperation>,
) => Promise<FixedOperationOutcome>;

type AcceptOperation = (
  operation: RegisteredOperation,
  outcome: FixedOperationOutcome,
  dependencies?: ReadonlySet<RegisteredOperation>,
) => void;

type SelectedOperation = [RegisteredOperation, Pick<Invocation, 'declaration' | 'block'>];
type FollowUpSelection = { entry: SelectedOperation } | { error: unknown } | undefined;

interface SourceSelection {
  readonly provider: RegisteredOperation;
  readonly resolver: RegisteredOperation | undefined;
  readonly dependencies: FixedWorkflowSource['dependencies'];
  readonly invocation: Invocation;
}

/**
 * Snapshot run data before evaluating contributions or awaiting their ports.
 * @param input - Worker-owned run inputs.
 * @returns Immutable scheduler inputs.
 */
function snapshotRun(input: FixedOperationRun): FixedOperationRun {
  return Object.freeze({
    ...input,
    definition: deepFreeze(structuredClone(input.definition)),
    source: deepFreeze(structuredClone(input.source)),
    blocks: deepFreeze(structuredClone(input.blocks)),
  });
}
