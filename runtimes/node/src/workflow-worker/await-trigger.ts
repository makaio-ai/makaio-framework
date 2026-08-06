import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue, WorkflowAutomationTriggerBinding, WorkflowWorkerConfig } from '@makaio/contracts';
import type { AutomationTriggerResolver } from '@makaio/services-core/automation-trigger';
import {
  AUTOMATION_TRIGGER_BUILTINS_OWNER,
  AutomationTriggerBindingRuntime,
  busBackedAutomationTriggers,
} from '@makaio/services-core/automation-trigger';
import {
  compileWorkflowTriggerBindingFilter,
  assertWorkflowTriggerPayload,
} from '@makaio/subsystem-workflow-engine/workflow-trigger-binding-consumer';
import type { RuntimeLoadedWorkflow } from './types.js';

// ─────────────────────────────────────────────────────────────
// Module overview
//
// Await mode lets a worker start with an empty trigger payload and block until
// one of the workflow's declared trigger bindings fires. It is a *consumer* of
// automation triggers, exactly like the engine's reconciler, and applies the same
// binding semantics: canonical parameter validation by the trigger type, then the
// consumer-owned `filter` and `filterExpression`.
//
// The worker is an isolated process with no extension host, so it activates
// bus-backed trigger types over its own bus rather than resolving a host-owned
// registry. Every other kind — extension-contributed types, and schedules whose
// placement the host owns — is skipped: the worker has no way to activate a source
// it does not carry, and no way to know where a source it does not own already
// runs.
// ─────────────────────────────────────────────────────────────

/** Log prefix for await-mode diagnostics. */
const LOG_PREFIX = '[WorkflowWorkerAwaitTrigger]';

/**
 * Creates the resolver over the trigger types a worker can activate itself.
 *
 * Every bus-backed built-in, and nothing else: those need nothing but the
 * worker's bus, so activating them here observes exactly the events this worker's
 * bus carries and starts no source anyone else shares. Taking the whole
 * bus-backed set rather than naming individual factories is what keeps a future
 * bus-backed built-in awaitable without touching the worker.
 *
 * Cron is deliberately absent. Where a schedule runs is a host-composition
 * decision — a host may place it on one elected machine through a relay
 * scheduler — and a worker that built its own scheduler would fire the same
 * schedule a second time, locally, for as long as the await lasts. A worker
 * cannot know which placement its host chose, so it carries no scheduler at all
 * and cron bindings take the unresolvable-kind skip path.
 * @param bus - Worker bus used by bus-backed trigger sources.
 * @returns Resolver reporting the worker's own trigger types.
 */
function createWorkerTriggerResolver(bus: IMakaioBus): AutomationTriggerResolver {
  const types = busBackedAutomationTriggers(bus);

  return {
    resolveRegistration: (kind) => {
      const type = types.find((candidate) => candidate.kind === kind);
      return type === undefined ? undefined : { owner: AUTOMATION_TRIGGER_BUILTINS_OWNER, type };
    },
  };
}

/**
 * Subscribes the workflow's trigger bindings and resolves with the first
 * matching event payload.
 *
 * Every subscription is temporary: the runtime is closed before this function
 * returns, on success, failure, and abort alike, so a worker never leaves a
 * source running. Aborting therefore detaches the subscriptions as part of
 * rejecting. A workflow whose bindings are all unsubscribable here returns before
 * a runtime exists at all.
 * @param bus - Worker bus used by bus-backed trigger sources.
 * @param bindings - Declarative trigger bindings of the loaded workflow.
 * @param signal - Abort signal for cooperative cancellation.
 * @returns The first matching payload, or `undefined` when no binding could be
 *   subscribed in this worker.
 * @throws When a resolvable binding cannot be subscribed, when a
 *   `filterExpression` cannot be compiled, or when `signal` aborts first.
 */
async function awaitFirstTriggerEvent(
  bus: IMakaioBus,
  bindings: readonly WorkflowAutomationTriggerBinding[],
  signal: AbortSignal,
): Promise<Record<string, JsonValue> | undefined> {
  const resolver = createWorkerTriggerResolver(bus);
  const runtime = new AutomationTriggerBindingRuntime(resolver);
  const subscribable = bindings.flatMap((binding) => {
    const prepared = runtime.prepareBinding(binding);
    if (prepared === undefined) {
      console.warn(
        `${LOG_PREFIX} skipping binding '${binding.kind}': awaiting it inside a worker is unsupported. ` +
          `A worker carries only bus-backed trigger types; schedules and extension-contributed sources are ` +
          `activated by the host that owns their placement.`,
      );
      return [];
    }
    if (!prepared.workflowCompatible) {
      console.warn(`${LOG_PREFIX} skipping binding '${binding.kind}': its event payload does not have an object root.`);
      return [];
    }
    return [{ binding, prepared }];
  });
  if (subscribable.length === 0) {
    await runtime.close();
    return undefined;
  }

  try {
    if (signal.aborted) throw signal.reason ?? new Error('Await-trigger aborted');

    const matched = Promise.withResolvers<Record<string, JsonValue>>();
    // The promise must stay handled from the moment it exists: an abort can reject
    // it while the subscriptions below are still being acquired, and it is only
    // awaited once they have all settled.
    void matched.promise.catch(() => undefined);
    const onAbort = (): void => {
      matched.reject(signal.reason ?? new Error('Await-trigger aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // Every binding is subscribed before the first event is awaited, so an
      // unsubscribable binding fails the await instead of silently narrowing it.
      await Promise.all(
        subscribable.map(async ({ binding, prepared }) => {
          const matches = compileWorkflowTriggerBindingFilter(binding);
          await prepared.subscribe((event) => {
            if (!matches(event.payload)) return;
            matched.resolve(assertWorkflowTriggerPayload(event.payload));
          });
        }),
      );

      return await matched.promise;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  } finally {
    await runtime.close();
  }
}

/**
 * Applies workflow await-trigger semantics to a worker config.
 *
 * When the config explicitly selects `await-trigger` mode and the loaded
 * workflow declares trigger bindings, the worker blocks until one of them fires and
 * returns a config carrying that payload. Otherwise the original config is
 * returned unchanged — which is also what happens when none of the declared
 * bindings can be activated inside a worker.
 * @param config - Validated workflow worker configuration.
 * @param loaded - Loaded workflow definition and runtime step map.
 * @param bus - Worker bus used by bus-backed trigger sources.
 * @param signal - Abort signal for cooperative cancellation.
 * @returns Original config or a copy with the matched trigger payload.
 */
export async function resolveAwaitTriggerConfig(
  config: WorkflowWorkerConfig,
  loaded: RuntimeLoadedWorkflow,
  bus: IMakaioBus,
  signal: AbortSignal,
): Promise<WorkflowWorkerConfig> {
  const bindings = loaded.definition.triggers ?? [];
  if (config.triggerMode !== 'await-trigger' || bindings.length === 0) return config;

  const triggerPayload = await awaitFirstTriggerEvent(bus, bindings, signal);
  return triggerPayload === undefined ? config : { ...config, triggerPayload };
}
