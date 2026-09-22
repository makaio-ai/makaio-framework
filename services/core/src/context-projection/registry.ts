import {
  ContextProjectionDiagnosticSchema,
  ContextProjectionOccurrenceSchema,
  ContextProjectionPlanSchema,
  ContextProjectionProjectedValueSchema,
  ContextProjectionResultSchema,
  type ContextProjectionDiagnostic,
  type ContextProjectionOccurrence,
  type ContextProjectionPlan,
  type ContextProjectionProjectedValue,
  type ContextProjectionProjectStep,
  type ContextProjectionResult,
  type ContextProjectionSelectStep,
} from '@makaio/contracts/context-projection';
import type { JsonValue } from '@makaio/contracts/shared';
import { z } from 'zod';

/** Successful result returned by a registered source selector. */
export interface ContextProjectionSelectorResult {
  /** Occurrences selected by the resolver. */
  readonly occurrences: readonly ContextProjectionOccurrence[];
  /** Diagnostics emitted while selecting occurrences. */
  readonly diagnostics: readonly ContextProjectionDiagnostic[];
}

/** Successful result returned by a registered value projector. */
export interface ContextProjectionProjectorResult {
  /** JSON-safe values projected from the supplied occurrences. */
  readonly contributions: readonly ContextProjectionProjectedValue[];
  /** Diagnostics emitted while projecting values. */
  readonly diagnostics: readonly ContextProjectionDiagnostic[];
}

/** A typed registration for a source-occurrence selector. */
export interface ContextProjectionSelector<Context, Params extends JsonValue> {
  /** Stable selector identifier used by plans. */
  readonly id: string;
  /** Schema used to validate the plan's JSON-safe parameters. */
  readonly params: z.ZodType<Params>;
  /** Select occurrences from the host context. */
  select(input: {
    /** Named plan step invoking this selector. */
    readonly step: string;
    readonly params: Params;
    readonly occurrences?: readonly ContextProjectionOccurrence[];
    readonly context: Context;
    readonly signal: AbortSignal;
  }): Promise<ContextProjectionSelectorResult>;
}

/** A typed registration for a value projector. */
export interface ContextProjectionProjector<Context, Params extends JsonValue> {
  /** Stable projector identifier used by plans. */
  readonly id: string;
  /** Schema used to validate the plan's JSON-safe parameters. */
  readonly params: z.ZodType<Params>;
  /** Project JSON-safe values from selected occurrences. */
  project(input: {
    /** Named plan step invoking this projector. */
    readonly step: string;
    readonly params: Params;
    readonly occurrences: readonly ContextProjectionOccurrence[];
    readonly context: Context;
    readonly signal: AbortSignal;
  }): Promise<ContextProjectionProjectorResult>;
}

/** Thrown when a selector or projector identifier is registered more than once. */
export class ContextProjectionRegistrationError extends Error {
  /** @param id - Duplicate registration identifier. */
  public constructor(id: string) {
    super(`Context projection resolver '${id}' is already registered`);
    this.name = 'ContextProjectionRegistrationError';
  }
}

interface PreparedSelector<Context> {
  readonly select: (input: {
    readonly step: string;
    readonly occurrences?: readonly ContextProjectionOccurrence[];
    readonly context: Context;
    readonly signal: AbortSignal;
  }) => Promise<ContextProjectionSelectorResult>;
}

interface RegisteredSelector<Context> {
  readonly prepare: (params: JsonValue) => Promise<PreparedSelector<Context> | undefined>;
}

interface PreparedProjector<Context> {
  readonly project: (input: {
    readonly step: string;
    readonly occurrences: readonly ContextProjectionOccurrence[];
    readonly context: Context;
    readonly signal: AbortSignal;
  }) => Promise<ContextProjectionProjectorResult>;
}

interface RegisteredProjector<Context> {
  readonly prepare: (params: JsonValue) => Promise<PreparedProjector<Context> | undefined>;
}

const selectorOutputSchema = z
  .object({
    occurrences: z.array(ContextProjectionOccurrenceSchema),
    diagnostics: z.array(ContextProjectionDiagnosticSchema),
  })
  .strict();

const projectorOutputSchema = z
  .object({
    contributions: z.array(ContextProjectionProjectedValueSchema),
    diagnostics: z.array(ContextProjectionDiagnosticSchema),
  })
  .strict();

/**
 * Create a diagnostic owned by the evaluator.
 * @param step - Stable plan step name.
 * @param code - Machine-readable evaluator diagnostic code.
 * @param message - Source-safe diagnostic message.
 * @param severity - Diagnostic severity.
 * @returns A schema-compatible diagnostic.
 */
function diagnostic(
  step: string,
  code: string,
  message: string,
  severity: ContextProjectionDiagnostic['severity'] = 'error',
): ContextProjectionDiagnostic {
  return { step, severity, code, message };
}

/**
 * Throw the signal's cancellation reason when evaluation was aborted.
 * @param signal - Signal supplied to evaluation and handlers.
 */
function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Erase a selector's parameter type without widening its handler input.
 *
 * The closure owns the parse boundary: only a schema-produced `Params` value
 * reaches the typed selector implementation.
 * @param registration - Typed selector registration to erase.
 * @returns Erased selector registration.
 */
function registerSelector<Context, Params extends JsonValue>(
  registration: ContextProjectionSelector<Context, Params>,
): RegisteredSelector<Context> {
  return {
    prepare: async (params) => {
      const parsed = await registration.params.safeParseAsync(params);
      if (!parsed.success) return undefined;
      return {
        select: (input) => registration.select({ ...input, params: parsed.data }),
      };
    },
  };
}

/**
 * Erase a projector's parameter type while retaining its schema parse boundary.
 * @param registration - Typed projector registration to erase.
 * @returns Erased projector registration.
 */
function registerProjector<Context, Params extends JsonValue>(
  registration: ContextProjectionProjector<Context, Params>,
): RegisteredProjector<Context> {
  return {
    prepare: async (params) => {
      const parsed = await registration.params.safeParseAsync(params);
      if (!parsed.success) return undefined;
      return {
        project: (input) => registration.project({ ...input, params: parsed.data }),
      };
    },
  };
}

/**
 * Host-owned evaluator for declarative context projection plans.
 *
 * Registrations are process-local callbacks. Plans remain pure data and are
 * fully preflighted before any callback runs.
 */
export class ContextProjectionRegistry<Context> {
  private readonly selectors = new Map<string, RegisteredSelector<Context>>();
  private readonly projectors = new Map<string, RegisteredProjector<Context>>();

  /**
   * Register a selector under its stable identifier.
   * @param registration - Selector registration to install.
   */
  public registerSelector<Params extends JsonValue>(registration: ContextProjectionSelector<Context, Params>): void {
    if (this.selectors.has(registration.id)) throw new ContextProjectionRegistrationError(registration.id);
    this.selectors.set(registration.id, registerSelector(registration));
  }

  /**
   * Register a projector under its stable identifier.
   * @param registration - Projector registration to install.
   */
  public registerProjector<Params extends JsonValue>(registration: ContextProjectionProjector<Context, Params>): void {
    if (this.projectors.has(registration.id)) throw new ContextProjectionRegistrationError(registration.id);
    this.projectors.set(registration.id, registerProjector(registration));
  }

  /**
   * Evaluate a plan against one host-supplied context.
   * @param plan - Declarative context projection plan.
   * @param input - Host context and optional cancellation signal.
   * @returns Composed contributions and diagnostics.
   */
  public async evaluate(
    plan: ContextProjectionPlan,
    input: { readonly context: Context; readonly signal?: AbortSignal },
  ): Promise<ContextProjectionResult> {
    const signal = input.signal ?? new AbortController().signal;
    abortIfNeeded(signal);

    const parsedPlan = this.parsePlan(plan);
    if (!parsedPlan) {
      return this.result(
        [],
        [diagnostic('plan', 'context-projection-plan-invalid', 'Context projection plan is invalid.')],
      );
    }

    const preflight = await this.preflight(parsedPlan, signal);
    abortIfNeeded(signal);
    if (preflight.diagnostics.length > 0) return this.result([], preflight.diagnostics);

    const selected = new Map<string, readonly ContextProjectionOccurrence[] | undefined>();
    const projected = new Map<string, readonly ContextProjectionProjectedValue[]>();
    const diagnostics: ContextProjectionDiagnostic[] = [];

    for (const step of parsedPlan.steps) {
      abortIfNeeded(signal);
      if (step.op === 'select') {
        await this.evaluateSelector(
          step,
          preflight.selectors.get(step.as),
          input.context,
          signal,
          selected,
          diagnostics,
        );
        continue;
      }

      if (step.op === 'project') {
        await this.evaluateProjector(
          step,
          preflight.projectors.get(step.as),
          input.context,
          signal,
          selected,
          projected,
          diagnostics,
        );
        continue;
      }

      const contributions = this.compose(step.sections, step.budget?.maxContributions, projected, diagnostics);
      return this.result(contributions, diagnostics);
    }

    return this.result([], diagnostics);
  }

  private async evaluateSelector(
    step: ContextProjectionSelectStep,
    selector: PreparedSelector<Context> | undefined,
    context: Context,
    signal: AbortSignal,
    selected: Map<string, readonly ContextProjectionOccurrence[] | undefined>,
    diagnostics: ContextProjectionDiagnostic[],
  ): Promise<void> {
    const upstream = step.from === undefined ? undefined : selected.get(step.from);
    if (step.from !== undefined && upstream === undefined) {
      selected.set(step.as, undefined);
      diagnostics.push(
        diagnostic(step.as, 'context-projection-dependency-failed', 'Context projection dependency failed.'),
      );
      return;
    }
    if (!selector) return;
    try {
      const output = selectorOutputSchema.safeParse(
        await selector.select({
          step: step.as,
          occurrences: upstream,
          context,
          signal,
        }),
      );
      abortIfNeeded(signal);
      if (!output.success) {
        selected.set(step.as, undefined);
        diagnostics.push(
          diagnostic(
            step.as,
            'context-projection-output-invalid',
            'Context projection resolver returned invalid output.',
          ),
        );
        return;
      }
      selected.set(step.as, output.data.occurrences);
      diagnostics.push(...output.data.diagnostics);
    } catch {
      abortIfNeeded(signal);
      selected.set(step.as, undefined);
      diagnostics.push(diagnostic(step.as, 'context-projection-step-failed', 'Context projection step failed.'));
    }
  }

  private async evaluateProjector(
    step: ContextProjectionProjectStep,
    projector: PreparedProjector<Context> | undefined,
    context: Context,
    signal: AbortSignal,
    selected: ReadonlyMap<string, readonly ContextProjectionOccurrence[] | undefined>,
    projected: Map<string, readonly ContextProjectionProjectedValue[]>,
    diagnostics: ContextProjectionDiagnostic[],
  ): Promise<void> {
    const occurrences = selected.get(step.from);
    if (occurrences === undefined) {
      diagnostics.push(
        diagnostic(step.as, 'context-projection-dependency-failed', 'Context projection dependency failed.'),
      );
      return;
    }
    if (!projector) return;
    try {
      const output = projectorOutputSchema.safeParse(
        await projector.project({ step: step.as, occurrences, context, signal }),
      );
      abortIfNeeded(signal);
      if (!output.success) {
        diagnostics.push(
          diagnostic(
            step.as,
            'context-projection-output-invalid',
            'Context projection resolver returned invalid output.',
          ),
        );
        return;
      }
      projected.set(step.as, output.data.contributions);
      diagnostics.push(...output.data.diagnostics);
    } catch {
      abortIfNeeded(signal);
      diagnostics.push(diagnostic(step.as, 'context-projection-step-failed', 'Context projection step failed.'));
    }
  }

  private async preflight(
    plan: ContextProjectionPlan,
    signal: AbortSignal,
  ): Promise<{
    readonly diagnostics: ContextProjectionDiagnostic[];
    readonly selectors: ReadonlyMap<string, PreparedSelector<Context>>;
    readonly projectors: ReadonlyMap<string, PreparedProjector<Context>>;
  }> {
    const diagnostics: ContextProjectionDiagnostic[] = [];
    const selectors = new Map<string, PreparedSelector<Context>>();
    const projectors = new Map<string, PreparedProjector<Context>>();
    for (const step of plan.steps) {
      abortIfNeeded(signal);
      if (step.op === 'compose') continue;
      if (step.op === 'select') {
        const registration = this.selectors.get(step.resolver);
        const prepared = registration ? await this.prepare(registration, step.params, signal) : undefined;
        if (prepared) {
          selectors.set(step.as, prepared);
          continue;
        }
        diagnostics.push(this.preflightDiagnostic(step.as, registration === undefined));
        continue;
      }

      const registration = this.projectors.get(step.resolver);
      const prepared = registration ? await this.prepare(registration, step.params, signal) : undefined;
      if (prepared) {
        projectors.set(step.as, prepared);
        continue;
      }
      diagnostics.push(this.preflightDiagnostic(step.as, registration === undefined));
    }
    return { diagnostics, selectors, projectors };
  }

  private preflightDiagnostic(step: string, resolverMissing: boolean): ContextProjectionDiagnostic {
    if (resolverMissing) {
      return diagnostic(
        step,
        'context-projection-resolver-not-registered',
        'Context projection resolver is not registered.',
      );
    }
    return diagnostic(step, 'context-projection-params-invalid', 'Context projection resolver parameters are invalid.');
  }

  private parsePlan(plan: ContextProjectionPlan): ContextProjectionPlan | undefined {
    try {
      const result = ContextProjectionPlanSchema.safeParse(plan);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async prepare<Prepared>(
    registration: { readonly prepare: (params: JsonValue) => Promise<Prepared | undefined> },
    params: JsonValue,
    signal: AbortSignal,
  ): Promise<Prepared | undefined> {
    abortIfNeeded(signal);
    try {
      const prepared = await registration.prepare(params);
      abortIfNeeded(signal);
      return prepared;
    } catch {
      abortIfNeeded(signal);
      return undefined;
    }
  }

  private compose(
    sections: readonly { readonly from: string; readonly label: string }[],
    maxContributions: number | undefined,
    projected: ReadonlyMap<string, readonly ContextProjectionProjectedValue[]>,
    diagnostics: ContextProjectionDiagnostic[],
  ): ContextProjectionResult['contributions'] {
    const contributions: ContextProjectionResult['contributions'] = [];
    for (const section of sections) {
      for (const contribution of projected.get(section.from) ?? []) {
        if (maxContributions !== undefined && contributions.length === maxContributions) {
          diagnostics.push(
            diagnostic(
              'compose',
              'context-projection-budget-exceeded',
              'Context projection contribution budget exceeded.',
              'warning',
            ),
          );
          return contributions;
        }
        contributions.push({ ...contribution, section: section.label, order: contributions.length });
      }
    }
    return contributions;
  }

  private result(
    contributions: ContextProjectionResult['contributions'],
    diagnostics: ContextProjectionDiagnostic[],
  ): ContextProjectionResult {
    const result = ContextProjectionResultSchema.safeParse({ contributions, diagnostics });
    if (result.success) return result.data;
    return {
      contributions: [],
      diagnostics: [diagnostic('result', 'context-projection-output-invalid', 'Context projection result is invalid.')],
    };
  }
}
