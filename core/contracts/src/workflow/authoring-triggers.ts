import type { ExtractSubjectPayload, SubjectDefinition, TypedPayloadFilter } from '@makaio/core';
import { getFullSubjectForSubjectDefinition } from '@makaio/core';
import type {
  BusEventTrigger,
  ExtensionWorkflowTrigger as ExtensionWorkflowTriggerType,
  WorkflowTrigger,
} from './schemas.js';

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
