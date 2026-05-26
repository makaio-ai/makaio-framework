import type {
  ExtractSubjectPayload,
  ExtractSubjectResponse,
  SubjectDefinition,
  TypedPayloadFilter,
} from '@makaio/core';
import { getFullSubjectForSubjectDefinition } from '@makaio/core';
import type { JsonValue } from '../shared/json-value.js';
import type {
  BusEventTrigger,
  BusRequestWorkflowStep,
  ExtensionWorkflowTrigger as ExtensionWorkflowTriggerType,
  FunctionWorkflowStep,
  WorkflowDefinitionInput,
  WorkflowStep,
  WorkflowTrigger,
} from './schemas.js';
import type { WorkflowStepBlock } from './blocks.js';

// ─────────────────────────────────────────────────────────────
// Typed Trigger Wrappers
// ─────────────────────────────────────────────────────────────

/**
 * A workflow trigger with a phantom type parameter carrying the payload type.
 *
 * Intentionally not an interface extending `WorkflowTrigger` because
 * `WorkflowTrigger` is a discriminated union — TypeScript does not permit
 * extending unions. Instead this type uses an intersection so the full trigger
 * shape is preserved while the phantom `__payload` field threads through.
 * @typeParam TPayload - The trigger event payload type
 */
export type WorkflowTriggerDef<TPayload> = WorkflowTrigger & {
  /**
   * Phantom type carrier — never present at runtime.
   * Use `ExtractTriggerPayload<T>` to access this type.
   */
  readonly __payload?: TPayload;
};

/**
 * Extract the payload type from a {@link WorkflowTriggerDef}.
 * @typeParam T - The typed trigger definition
 */
export type ExtractTriggerPayload<T extends WorkflowTriggerDef<unknown>> =
  T extends WorkflowTriggerDef<infer TPayload> ? TPayload : never;

/**
 * Derives the trigger payload union from a tuple of typed trigger definitions.
 * @typeParam TTriggers - Trigger tuple supplied to `defineWorkflow`
 */
export type TriggerPayloadFromTriggers<TTriggers extends readonly WorkflowTriggerDef<unknown>[] | undefined> =
  TTriggers extends readonly WorkflowTriggerDef<unknown>[] ? ExtractTriggerPayload<TTriggers[number]> : never;

/**
 * Creates a bus-event workflow trigger that fires when a typed subject emits
 * a matching message.
 * @param options - Trigger configuration options
 * @returns A typed workflow trigger definition
 * @example
 * ```typescript
 * const trigger = BusEventWorkflowTrigger({
 *   subject: GitNamespace.subjects.checkout,
 *   filter: { isNewWorktree: true },
 * });
 * ```
 */
export function BusEventWorkflowTrigger<S extends SubjectDefinition>(options: {
  /** The bus subject to subscribe to. */
  readonly subject: S;
  /** Optional structural payload filter (AND semantics). */
  readonly filter?: TypedPayloadFilter<ExtractSubjectPayload<S>>;
  /** Optional jexl expression for complex filter conditions. */
  readonly filterExpression?: string;
}): BusEventTrigger & { readonly __payload?: ExtractSubjectPayload<S> } {
  return {
    type: 'bus-event',
    subject: getFullSubjectForSubjectDefinition(options.subject),
    ...(options.filter !== undefined && {
      filter: options.filter as BusEventTrigger['filter'],
    }),
    ...(options.filterExpression !== undefined && {
      filterExpression: options.filterExpression,
    }),
  };
}

/**
 * Creates a manual workflow trigger (user-initiated only).
 * @returns A typed workflow trigger definition with `void` payload
 */
export function ManualWorkflowTrigger(): WorkflowTriggerDef<void> {
  return { type: 'manual' } as WorkflowTriggerDef<void>;
}

/**
 * Cron trigger payload — injected into `context.trigger` at execution time.
 */
export interface CronTriggerPayload {
  /** Epoch milliseconds when the cron fired. */
  readonly firedAt: number;
  /** Zero-based index of this trigger in the workflow's `triggers` array. */
  readonly triggerIndex: number;
}

/**
 * Creates a cron-based workflow trigger.
 * @param options - Trigger configuration options
 * @returns A typed workflow trigger definition with {@link CronTriggerPayload}
 */
export function CronWorkflowTrigger(options: {
  /** Cron expression (e.g. `'0 9 * * 1'`). */
  readonly schedule: string;
  /** Optional IANA timezone string; defaults to UTC at runtime. */
  readonly timezone?: string;
}): WorkflowTriggerDef<CronTriggerPayload> {
  return {
    type: 'cron',
    schedule: options.schedule,
    ...(options.timezone !== undefined && { timezone: options.timezone }),
  } as WorkflowTriggerDef<CronTriggerPayload>;
}

/**
 * Webhook trigger payload — injected into `context.trigger` at execution time.
 */
export interface WebhookTriggerPayload {
  /** Webhook event name (e.g. `'push'`, `'pull_request'`). */
  readonly event: string;
  /** Branch filter value, if configured. */
  readonly branch?: string;
  /** Repository slug (`owner/name`), if configured. */
  readonly repo?: string;
  /** Raw webhook payload forwarded from the webhook handler. */
  readonly body: Record<string, unknown>;
}

/**
 * Creates a webhook-based workflow trigger.
 * @param options - Trigger configuration options
 * @returns A typed workflow trigger definition with {@link WebhookTriggerPayload}
 */
export function WebhookWorkflowTrigger(options: {
  /** Webhook event name. */
  readonly event: string;
  /** Optional branch filter. */
  readonly branch?: string;
  /** Optional repository filter (`owner/name`). */
  readonly repo?: string;
}): WorkflowTriggerDef<WebhookTriggerPayload> {
  return {
    type: 'webhook',
    event: options.event,
    ...(options.branch !== undefined && { branch: options.branch }),
    ...(options.repo !== undefined && { repo: options.repo }),
  } as WorkflowTriggerDef<WebhookTriggerPayload>;
}

/**
 * Creates an extension-contributed workflow trigger.
 * @param options - Trigger configuration options
 * @returns A typed workflow trigger definition with `Record<string, unknown>` payload
 */
export function ExtensionWorkflowTrigger(options: {
  /** Extension trigger type identifier (`extensionName:eventName`). */
  readonly extensionType: `${string}:${string}`;
  /** Optional opaque runtime configuration. */
  readonly config?: Record<string, unknown>;
}): WorkflowTriggerDef<Record<string, unknown>> {
  const trigger: ExtensionWorkflowTriggerType = {
    type: 'extension',
    extensionType: options.extensionType,
    ...(options.config !== undefined && { config: options.config }),
  };
  return trigger as WorkflowTriggerDef<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────
// Bus Request Step Authoring
// ─────────────────────────────────────────────────────────────

/**
 * Narrows {@link SubjectDefinition} to request subjects only.
 *
 * A request subject carries a `$meta.isRequest: true` discriminant, meaning
 * its payload is a `{ request: ...; response: ... }` pair. Only request
 * subjects are valid operands for {@link BusRequestStep}.
 */
type RequestSubjectDefinition = SubjectDefinition & {
  readonly $meta: SubjectDefinition['$meta'] & { readonly isRequest: true };
};

/**
 * A template string is a `{{ expression }}` placeholder that the workflow
 * engine resolves at execution time against the expression context.
 */
type TemplateString = `{{${string}}}`;

/**
 * Widens each leaf type so that template placeholders (`{{ ... }}`) are
 * accepted wherever a concrete value would normally be required.
 *
 * - Wide `string` fields already accept any string, so no widening is needed.
 * - String literal and enum fields preserve their declared union while
 *   accepting whole-value template placeholders.
 * - `number | boolean | null` fields also accept a `TemplateString`.
 * - Arrays recurse element-wise.
 * - Records recurse key-wise.
 * @typeParam T - The concrete payload field type to widen
 */
type TemplateValue<T> = T extends string
  ? string extends T
    ? string
    : T | TemplateString
  : T extends number | boolean | null
    ? T | TemplateString
    : T extends readonly (infer Item)[]
      ? readonly TemplateValue<Item>[]
      : T extends Record<string, unknown>
        ? { readonly [K in keyof T]: TemplateValue<T[K]> }
        : T;

/**
 * Payload shape accepted by {@link BusRequestStep}, where every leaf value
 * may be either the concrete type or a `{{ expression }}` template string.
 * @typeParam TPayload - The request subject's concrete payload type
 */
export type BusRequestStepPayload<TPayload> =
  TPayload extends Record<string, unknown> ? { readonly [K in keyof TPayload]: TemplateValue<TPayload[K]> } : never;

/**
 * A {@link BusRequestWorkflowStep} with a phantom `__output` type parameter
 * carrying the response type through the authoring graph.
 *
 * The phantom field is never present at runtime — it exists only so the
 * TypeScript compiler can thread the response type through
 * {@link WorkflowBuilder.addBusRequestStep} into the returned {@link StepRef}.
 * @typeParam TOutput - The request subject's response type
 */
export interface TypedBusRequestWorkflowStep<TOutput extends JsonValue> extends BusRequestWorkflowStep {
  /**
   * Phantom type carrier — never present at runtime.
   * Access via the `StepRef` returned by `addBusRequestStep`.
   */
  readonly __output?: TOutput;
}

/**
 * Options accepted by {@link WorkflowBuilder.addBusRequestStep}.
 * @typeParam TNeeds - Tuple of predecessor step refs
 */
export interface WorkflowSchemaStepOptions<TNeeds extends readonly StepRef<string, JsonValue>[]> {
  /** Predecessor steps that must complete before this step runs. */
  readonly needs: TNeeds;
  /** Optional jexl condition; falsy skips the step at runtime. */
  readonly if?: string;
}

/**
 * Creates a typed bus-request workflow step from a `SubjectDefinition`.
 *
 * Serializes the subject token to its fully-qualified string form and attaches
 * a phantom response-type parameter so downstream steps receive a typed
 * `previousSteps` entry via the returned `StepRef`.
 * @param options - Step configuration options
 * @returns A {@link TypedBusRequestWorkflowStep} carrying the response type.
 *   The returned object uses `id: ''` as a placeholder — always pass it to
 *   {@link WorkflowBuilder.addBusRequestStep} which assigns the real step ID.
 * @example
 * ```typescript
 * const created = workflow.addBusRequestStep(
 *   'create-issue',
 *   BusRequestStep({
 *     subject: GitHubAppNamespace.subjects['issue.create'],
 *     payload: { owner: '{{ inputs.owner }}', repo: '{{ inputs.repo }}', title: 'Plan' },
 *   }),
 *   { needs: [] },
 * );
 * ```
 */
export function BusRequestStep<S extends RequestSubjectDefinition>(options: {
  /** The request subject definition to subscribe to. */
  readonly subject: S;
  /** Optional template-aware payload. Supports `{{ expression }}` placeholders. */
  readonly payload?: BusRequestStepPayload<ExtractSubjectPayload<S>>;
  /** Request timeout in milliseconds. `0` disables automatic timeout. */
  readonly timeoutMs?: number;
}): TypedBusRequestWorkflowStep<ExtractSubjectResponse<S> & JsonValue> {
  return {
    type: 'bus-request',
    id: '',
    subject: getFullSubjectForSubjectDefinition(options.subject),
    ...(options.payload !== undefined && { payload: options.payload }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  };
}

// ─────────────────────────────────────────────────────────────
// Block Compile Helper
// ─────────────────────────────────────────────────────────────

const OMIT_TEMPLATE_VALUE = Symbol('omit-template-value');
const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const WHOLE_TEMPLATE_PATTERN = /^\s*\{\{\s*([^{}]*?)\s*\}\}\s*$/;
const COMPILE_TIME_TEMPLATE_PATH_PATTERN = /^(?:config|input)(?:\.[a-zA-Z0-9_]+)*$/;
const COMPILE_TIME_TEMPLATE_ROOT_PATTERN = /^(?:config|input)\b/;

/**
 * Resolves a dot-notation path against a plain context object.
 *
 * Walks the path segments left-to-right, returning `undefined` if any
 * intermediate value is absent or not an object.
 * @param path - Dot-separated property path, e.g. `'config.owner'`
 * @param context - Root context object to traverse
 * @returns The resolved value, or `undefined` if the path cannot be walked
 */
function resolvePlainPath(path: string, context: Record<string, unknown>): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, context);
}

/**
 * Checks whether a workflow block template expression is a supported
 * compile-time path rooted at `config` or `input`.
 * @param expression - Template expression without surrounding braces
 * @returns True when the expression can be resolved during block compilation
 */
function isCompileTimeTemplatePath(expression: string): boolean {
  return COMPILE_TIME_TEMPLATE_PATH_PATTERN.test(expression);
}

/**
 * Rejects unsupported compile-time block template expressions.
 *
 * Runtime workflow expressions do not expose `config` or `input`, so block
 * compilation must either resolve those roots or fail before persistence.
 * @param expression - Template expression without surrounding braces
 * @throws When a `config` or `input` expression is not a plain dot path
 */
function assertSupportedBlockTemplateExpression(expression: string): void {
  if (isCompileTimeTemplatePath(expression)) return;
  if (!COMPILE_TIME_TEMPLATE_ROOT_PATTERN.test(expression)) return;

  throw new Error(
    `Unsupported workflow block template "{{ ${expression} }}": ` +
      'config/input templates only support plain dot-path placeholders.',
  );
}

/**
 * Resolves a single template value against a plain context object.
 *
 * - If `value` is not a string it is returned as-is.
 * - A whole-value template (`{{ path }}`) returns the native resolved value
 *   (preserving non-string types such as numbers and booleans). Missing
 *   compile-time paths return an internal omission marker.
 * - An inline template (partial `{{ path }}` inside a larger string) replaces
 *   each supported compile-time placeholder with its stringified resolved
 *   value and leaves runtime placeholders intact.
 * @param value - The payload leaf value, potentially containing `{{ ... }}` placeholders
 * @param context - Root context object used for path resolution
 * @returns The resolved value, or an internal omission marker
 */
function resolvePlainTemplateValue(
  value: unknown,
  context: Record<string, unknown>,
): unknown | typeof OMIT_TEMPLATE_VALUE {
  if (typeof value !== 'string') return value;
  const wholeMatch = WHOLE_TEMPLATE_PATTERN.exec(value);
  if (wholeMatch) {
    const expression = wholeMatch[1].trim();
    assertSupportedBlockTemplateExpression(expression);
    if (!isCompileTimeTemplatePath(expression)) return value;

    const resolved = resolvePlainPath(expression, context);
    return resolved === undefined ? OMIT_TEMPLATE_VALUE : resolved;
  }

  return value.replace(TEMPLATE_PLACEHOLDER_PATTERN, (full, rawExpression: string) => {
    const expression = rawExpression.trim();
    assertSupportedBlockTemplateExpression(expression);
    if (!isCompileTimeTemplatePath(expression)) return full;

    const resolved = resolvePlainPath(expression, context);
    return resolved == null ? '' : String(resolved);
  });
}

/**
 * Recursively resolves compile-time `config`/`input` template placeholders in a
 * plain object.
 * @param obj - Source object whose leaf string values may contain placeholders
 * @param context - Root context used for path resolution
 * @returns A new object with supported compile-time placeholders resolved
 */
function resolveTemplatesInPlainObject(
  obj: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const entries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      entries.push([
        key,
        value.map((item) => {
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            return resolveTemplatesInPlainObject(item as Record<string, unknown>, context);
          }
          const resolved = resolvePlainTemplateValue(item, context);
          return resolved === OMIT_TEMPLATE_VALUE ? null : resolved;
        }),
      ]);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      entries.push([key, resolveTemplatesInPlainObject(value as Record<string, unknown>, context)]);
      continue;
    }

    const resolved = resolvePlainTemplateValue(value, context);
    if (resolved !== OMIT_TEMPLATE_VALUE) {
      entries.push([key, resolved]);
    }
  }

  return Object.fromEntries(entries);
}

/**
 * Compile a declarative bus-request workflow block into a concrete workflow step.
 *
 * Resolves all `{{ config.* }}` and `{{ input.* }}` template placeholders in the
 * block's `runs.payload` against the supplied `values`. Whole-value templates
 * (`{{ config.count }}`) preserve the native resolved type; inline templates
 * (partial substitutions inside a larger string) are coerced to string.
 *
 * This helper performs compile-time, builder-side resolution for simple
 * dot-path expressions rooted at `config` or `input` (`{{ config.owner }}`,
 * `{{ input.title }}`). Unsupported `config`/`input` expressions throw during
 * compilation because those roots are not available in the runtime expression
 * context.
 * @param block - Extension-contributed step block with a bus-request run mapping.
 * @param values - Concrete config and input values selected by the workflow builder.
 * @returns Serializable bus-request workflow step with resolved config/input templates.
 */
export function BusRequestStepFromBlock(
  block: WorkflowStepBlock,
  values: {
    readonly config: Record<string, unknown>;
    readonly input: Record<string, unknown>;
  },
): BusRequestWorkflowStep {
  if (block.runs.type !== 'bus-request') {
    throw new Error(`Unsupported workflow block run type: ${block.runs.type}`);
  }

  const context: Record<string, unknown> = {
    config: values.config,
    input: values.input,
  };

  return {
    type: 'bus-request',
    id: '',
    subject: block.runs.subject,
    ...(block.runs.payload !== undefined && {
      payload: resolveTemplatesInPlainObject(block.runs.payload, context),
    }),
    ...(block.runs.timeoutMs !== undefined && { timeoutMs: block.runs.timeoutMs }),
  };
}

// ─────────────────────────────────────────────────────────────
// Workflow Context
// ─────────────────────────────────────────────────────────────

/**
 * Platform and workspace context fields shared by both {@link WorkflowContext}
 * and {@link StepContext}.
 *
 * Separating these base fields from the trigger field allows {@link StepContext}
 * to narrow `trigger` to the concrete payload type while re-using all other fields.
 */
export interface WorkflowContextBase {
  /** Absolute path to the active repository root. */
  readonly repoPath: string;
  /** Absolute path to the Makaio home directory. */
  readonly makaioHome: string;
  /** Host operating system. */
  readonly os: 'darwin' | 'linux' | 'win32';
  /** CPU architecture (e.g. `'arm64'`, `'x64'`). */
  readonly arch: string;
  /** Active git worktree path, if different from `repoPath`. */
  readonly worktree?: string;
  /** Bound input values for this execution. */
  readonly inputs: Record<string, unknown>;
  /** Extra environment variables injected into the worker process. */
  readonly env: Record<string, string>;
  /** Unique execution identifier. */
  readonly executionId: string;
  /** Workflow definition identifier. */
  readonly workflowId: string;
}

/**
 * Platform and workspace context available to every workflow step function.
 *
 * These fields are populated from `WorkflowWorkerConfig.context` and the
 * current execution record at dispatch time.
 */
export interface WorkflowContext extends WorkflowContextBase {
  /** Payload from the trigger that started this execution. */
  readonly trigger: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// Step Refs and Output Types
// ─────────────────────────────────────────────────────────────

/**
 * A reference to a completed predecessor step, carrying the step's inferred
 * output type so downstream steps receive fully-typed `previousSteps` entries.
 * @typeParam TId - Literal step ID string
 * @typeParam TOutput - JSON-serializable output type produced by the step
 */
export interface StepRef<TId extends string, TOutput extends JsonValue> {
  /** Unique step identifier within the workflow. */
  readonly id: TId;
  /**
   * Phantom type carrier — never present at runtime.
   * Use via {@link PreviousStepsFromRefs} to access the typed output in downstream steps.
   * Direct access always yields `undefined` at runtime; read from `ctx.previousSteps` instead.
   */
  readonly __output?: TOutput;
}

/**
 * The shape of a declared dependency entry in `ctx.previousSteps`.
 *
 * Scheduler dependencies can be satisfied by completed or skipped upstream
 * steps. Both remain visible so downstream functions can branch on the
 * terminal status of every declared dependency.
 * @typeParam TOutput - The step's inferred output type
 */
export type PreviousStepOutput<TOutput extends JsonValue> =
  | {
      /** JSON-serializable value produced by the completed step. */
      readonly output: TOutput;
      /** Upstream step completed and produced an output. */
      readonly status: 'completed';
    }
  | {
      /** Skipped upstream steps do not produce an output. */
      readonly output?: undefined;
      /** Upstream step was skipped by its `if` condition. */
      readonly status: 'skipped';
    };

/**
 * Derives a `previousSteps` record type from a tuple of {@link StepRef}s.
 *
 * Each ref in the tuple produces a keyed entry in the result, preserving the
 * exact `TOutput` type rather than widening to `JsonValue`.
 * @typeParam TRefs - Tuple of StepRef instances declared in `needs`
 */
export type PreviousStepsFromRefs<TRefs extends readonly StepRef<string, JsonValue>[]> = {
  readonly [Ref in TRefs[number] as Ref['id']]: Ref extends StepRef<string, infer TOutput>
    ? PreviousStepOutput<TOutput>
    : never;
};

// ─────────────────────────────────────────────────────────────
// Step Context
// ─────────────────────────────────────────────────────────────

/**
 * Full execution context passed to a workflow step function.
 *
 * Extends {@link WorkflowContextBase} with a typed `trigger` field and the
 * `previousSteps` map. `TTrigger` is not constrained to `Record<string, unknown>`
 * so that strongly-typed trigger payloads can narrow the field beyond the base
 * `WorkflowContext` constraint.
 * @typeParam TTrigger - The trigger payload type
 * @typeParam TPreviousSteps - Map of completed predecessor step outputs
 */
export interface StepContext<TTrigger, TPreviousSteps extends Record<string, PreviousStepOutput<JsonValue>>>
  extends WorkflowContextBase {
  /** Typed payload from the trigger that started this execution. */
  readonly trigger: TTrigger;
  /**
   * Outputs from predecessor steps declared in `needs`.
   * Only steps listed in `needs` are guaranteed to be present.
   */
  readonly previousSteps: TPreviousSteps;
  /** Current collection item when running inside a `for-each` expansion. */
  readonly item?: unknown;
  /** Zero-based iteration index when running inside a `for-each` expansion. */
  readonly index?: number;
  /** Abort signal for cooperative cancellation of long-running function steps. */
  readonly signal: AbortSignal;
}

// ─────────────────────────────────────────────────────────────
// Step Function Type
// ─────────────────────────────────────────────────────────────

/**
 * Callable step handler for a function-type workflow step.
 *
 * The return type must be JSON-serializable so results can be persisted and
 * forwarded to downstream steps.
 * @typeParam TTrigger - The trigger payload type
 * @typeParam TPreviousSteps - Map of completed predecessor step outputs
 * @typeParam TOutput - JSON-serializable output type
 */
export type WorkflowStepFunction<
  TTrigger,
  TPreviousSteps extends Record<string, PreviousStepOutput<JsonValue>>,
  TOutput extends JsonValue,
> = (ctx: StepContext<TTrigger, TPreviousSteps>) => TOutput | Promise<TOutput>;

// ─────────────────────────────────────────────────────────────
// defineWorkflow Options
// ─────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link defineWorkflow} to configure the workflow metadata.
 */
export interface DefineWorkflowOptions<
  TTriggers extends readonly WorkflowTriggerDef<unknown>[] | undefined = undefined,
> {
  /** Human-readable workflow name. */
  readonly name: string;
  /** Human-readable description of what this workflow does. */
  readonly description?: string;
  /** Initial trigger set. Additional triggers can be added via `addTrigger`. */
  readonly triggers?: TTriggers;
}

/**
 * Options accepted by `WorkflowBuilder.addStep`.
 * @typeParam TNeeds - Tuple of predecessor step refs
 */
export interface WorkflowFunctionStepOptions<TNeeds extends readonly StepRef<string, JsonValue>[]> {
  /** Predecessor steps that must complete before this step runs. */
  readonly needs: TNeeds;
  /** Optional jexl condition; falsy skips the step at runtime. */
  readonly if?: string;
}

// ─────────────────────────────────────────────────────────────
// Workflow Builder
// ─────────────────────────────────────────────────────────────

/**
 * A fluent workflow builder returned by {@link defineWorkflow}.
 *
 * Collects trigger definitions and typed step registrations, then exposes
 * the serializable `WorkflowDefinitionInput` alongside the runtime step map
 * for the worker executor.
 * @typeParam TTrigger - Trigger payload type (from the first added trigger)
 */
export interface WorkflowBuilder<TTrigger = never> {
  /** Workflow definition identifier. */
  readonly id: string;
  /**
   * Serializable workflow definition — safe to store, display in the UI,
   * and pass over the bus. Does not contain function bodies.
   */
  readonly definition: WorkflowDefinitionInput;
  /**
   * Runtime step map keyed by step ID.
   * Used by the worker executor to dispatch function steps.
   */
  readonly runtimeSteps: ReadonlyMap<
    string,
    WorkflowStepFunction<unknown, Record<string, PreviousStepOutput<JsonValue>>, JsonValue>
  >;
  /**
   * Appends a trigger to the workflow definition.
   * @param trigger - The trigger to add
   */
  addTrigger<TPayload>(trigger: WorkflowTriggerDef<TPayload>): WorkflowBuilder<TTrigger | TPayload>;
  /**
   * Registers a typed function step and appends it to the workflow definition.
   *
   * The exact `TOutput` inferred from `fn`'s return type is preserved in the
   * returned `StepRef` so downstream steps receive a fully-typed
   * `previousSteps` map entry.
   * @param id - Unique step identifier within this workflow
   * @param fn - Step handler function; must return a JSON-serializable value
   * @param options - Step options including predecessor `needs` refs
   * @returns A `StepRef` carrying the inferred output type
   */
  addStep<
    const TId extends string,
    const TNeeds extends readonly StepRef<string, JsonValue>[],
    TOutput extends JsonValue,
  >(
    id: TId,
    fn: WorkflowStepFunction<TTrigger, PreviousStepsFromRefs<TNeeds>, TOutput>,
    options: WorkflowFunctionStepOptions<TNeeds>,
  ): StepRef<TId, TOutput>;
  /**
   * Registers a schema-driven bus-request step and appends it to the workflow
   * definition.
   *
   * Unlike `addStep`, no runtime function is registered — the step is executed
   * entirely by the scheduler via the bus. The response type from `config` is
   * preserved in the returned `StepRef` so downstream steps receive a
   * fully-typed `previousSteps` entry.
   * @param stepId - Unique step identifier within this workflow
   * @param config - Typed bus request step produced by {@link BusRequestStep}
   * @param stepOptions - Step options including predecessor `needs` refs
   * @returns A `StepRef` carrying the response type
   */
  addBusRequestStep<
    const TId extends string,
    const TNeeds extends readonly StepRef<string, JsonValue>[],
    TOutput extends JsonValue,
  >(
    stepId: TId,
    config: TypedBusRequestWorkflowStep<TOutput>,
    stepOptions: WorkflowSchemaStepOptions<TNeeds>,
  ): StepRef<TId, TOutput>;
}

/** Partial step fields contributed by the `needs`/`if` dependency options. */
type SerializedStepDependencies = { needs?: string[]; if?: string };

/**
 * Serializes the `needs` and `if` fields from step options into their
 * wire-format equivalents. Shared by `addStep` and `addBusRequestStep`.
 * @param needs - Predecessor step refs
 * @param condition - Optional jexl condition string
 * @returns Partial step fields for `needs` and `if`, omitted when empty/absent
 */
function serializeStepDependencies(
  needs: readonly StepRef<string, JsonValue>[],
  condition: string | undefined,
): SerializedStepDependencies {
  return {
    ...(needs.length > 0 && { needs: needs.map((ref) => ref.id) }),
    ...(condition !== undefined && { if: condition }),
  };
}

/**
 * Registers `stepId` in `registry`, throwing if already present.
 * @param registry - The set of already-claimed step IDs
 * @param stepId - Unique step identifier to claim
 */
function claimStepId(registry: Set<string>, stepId: string): void {
  if (registry.has(stepId)) {
    throw new Error(`Duplicate step ID: ${stepId}`);
  }
  registry.add(stepId);
}

/**
 * Creates a typed workflow builder for function-based workflow definitions.
 *
 * The builder collects steps and triggers in a type-safe manner, propagating
 * step output types through the `needs` dependency graph. The resulting
 * `definition` is serializable for storage and UI; `runtimeSteps` is used
 * by the executor to call the actual functions.
 * @param id - Unique workflow definition identifier
 * @param options - Optional initial workflow metadata (name, description, triggers)
 * @returns A {@link WorkflowBuilder} instance
 * @example
 * ```typescript
 * const workflow = defineWorkflow('my-flow', {
 *   name: 'My Flow',
 *   triggers: [ManualWorkflowTrigger()],
 * });
 *
 * const step1 = workflow.addStep(
 *   'fetch',
 *   async (ctx) => ({ data: await fetchSomething(ctx.repoPath) }),
 *   { needs: [] },
 * );
 *
 * workflow.addStep(
 *   'process',
 *   (ctx) => ({ count: ctx.previousSteps['fetch'].output.data.length }),
 *   { needs: [step1] },
 * );
 * ```
 */
export function defineWorkflow<const TTriggers extends readonly WorkflowTriggerDef<unknown>[] | undefined = undefined>(
  id: string,
  options?: DefineWorkflowOptions<TTriggers>,
): WorkflowBuilder<TriggerPayloadFromTriggers<TTriggers>> {
  const steps: WorkflowStep[] = [];
  const runtimeSteps = new Map<
    string,
    WorkflowStepFunction<unknown, Record<string, PreviousStepOutput<JsonValue>>, JsonValue>
  >();
  const registeredStepIds = new Set<string>();
  const name = options?.name ?? id;
  const triggers: WorkflowTrigger[] = options?.triggers ? [...options.triggers] : [];

  const definition: WorkflowDefinitionInput = {
    id,
    name,
    ...(options?.description !== undefined && { description: options.description }),
    steps,
    triggers,
    scope: { type: 'global' },
  };

  return {
    id,
    definition,
    runtimeSteps,
    addTrigger<TPayload>(
      trigger: WorkflowTriggerDef<TPayload>,
    ): WorkflowBuilder<TriggerPayloadFromTriggers<TTriggers> | TPayload> {
      triggers.push(trigger);
      return this as WorkflowBuilder<TriggerPayloadFromTriggers<TTriggers> | TPayload>;
    },
    addStep<
      const TId extends string,
      const TNeeds extends readonly StepRef<string, JsonValue>[],
      TOutput extends JsonValue,
    >(
      stepId: TId,
      fn: WorkflowStepFunction<TriggerPayloadFromTriggers<TTriggers>, PreviousStepsFromRefs<TNeeds>, TOutput>,
      stepOptions: WorkflowFunctionStepOptions<TNeeds>,
    ): StepRef<TId, TOutput> {
      claimStepId(registeredStepIds, stepId);
      const serializedStep: FunctionWorkflowStep = {
        type: 'function',
        id: stepId,
        runtime: true,
        ...serializeStepDependencies(stepOptions.needs, stepOptions.if),
      };
      steps.push(serializedStep);
      // Wrap fn in a lambda so the executor map accepts the wider signature without
      // a cast. The executor always provides a fully-resolved context that satisfies
      // the narrower TTrigger/TPreviousSteps constraints at runtime.
      runtimeSteps.set(stepId, (ctx) =>
        fn(ctx as StepContext<TriggerPayloadFromTriggers<TTriggers>, PreviousStepsFromRefs<TNeeds>>),
      );
      return { id: stepId } as StepRef<TId, TOutput>;
    },
    addBusRequestStep<
      const TId extends string,
      const TNeeds extends readonly StepRef<string, JsonValue>[],
      TOutput extends JsonValue,
    >(
      stepId: TId,
      config: TypedBusRequestWorkflowStep<TOutput>,
      stepOptions: WorkflowSchemaStepOptions<TNeeds>,
    ): StepRef<TId, TOutput> {
      claimStepId(registeredStepIds, stepId);
      const serializedStep: BusRequestWorkflowStep = {
        type: 'bus-request',
        id: stepId,
        subject: config.subject,
        ...(config.payload !== undefined && { payload: config.payload }),
        ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
        ...serializeStepDependencies(stepOptions.needs, stepOptions.if),
      };
      steps.push(serializedStep);
      return { id: stepId } as StepRef<TId, TOutput>;
    },
  };
}
