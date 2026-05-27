import { z } from 'zod';
import type { ICapabilityProvider } from '../../capability/index.js';
import type { WorkflowRunResult, WorkflowWorkerConfig, WorkerContributionManifest } from '../../workflow/index.js';
import { JsonObjectContractSchema } from '../../shared/json-value.js';

/** Capability identifier used for WorkerNode providers. */
export const WORKER_NODE_CAPABILITY_ID = 'worker-node' as const;

/** Provider identifier reserved for the runtime-node built-in Piscina WorkerNode provider. */
export const BUILT_IN_PISCINA_WORKER_NODE_PROVIDER_ID = 'makaio.runtime-node.piscina-local' as const;

/**
 * Zod schema for the capabilities advertised by a WorkerNode provider.
 *
 * `customCapabilities` is an open list so product hosts can declare
 * domain-specific tags (e.g. `'workflow.bus-events'`) without modifying
 * the framework contract.
 */
export const WorkerNodeCapabilitiesSchema = z.object({
  /** Optional upper bound on a single execution's wall-clock duration, in milliseconds. */
  maxRuntimeMs: z.number().int().positive().optional(),
  /** Whether the execution environment retains state across restarts. */
  persistentStorage: z.boolean(),
  /** Product- or environment-specific capability tags. */
  customCapabilities: z.array(z.string().min(1)).default([]),
});

/** Provider capabilities advertised when registering a WorkerNode provider. */
export type WorkerNodeCapabilities = z.input<typeof WorkerNodeCapabilitiesSchema>;

/** Provider capabilities after schema defaults have been applied. */
export type NormalizedWorkerNodeCapabilities = z.output<typeof WorkerNodeCapabilitiesSchema>;

/**
 * Zod schema for the resource requirements a workflow dispatch can express
 * during pool/provider selection.
 *
 * All fields are optional: omitted requirements impose no constraint on
 * provider selection.
 */
export const WorkerNodeRequirementsSchema = z.object({
  /** Maximum acceptable wall-clock duration for the execution, in milliseconds. */
  maxRuntimeMs: z.number().int().positive().optional(),
  /** Whether the target environment must offer persistent storage. */
  persistentStorage: z.boolean().optional(),
  /** Capability tags that the selected provider must advertise. */
  customCapabilities: z.array(z.string().min(1)).default([]),
});

/** Resource requirements that constrain WorkerNode provider selection. */
export type WorkerNodeRequirements = z.input<typeof WorkerNodeRequirementsSchema>;

/** Resource requirements after schema defaults have been applied. */
export type NormalizedWorkerNodeRequirements = z.output<typeof WorkerNodeRequirementsSchema>;

/**
 * Request handed to a WorkerNode provider after pool dispatch has selected it.
 *
 * This is a framework-level transfer object. Pool identity and resource
 * allocation details live in the product-owned dispatch layer above this
 * contract.
 */
export interface WorkerNodeProvisionRequest {
  /** Unique identifier for this node instance within an execution. */
  readonly nodeId: string;
  /** Unique workflow execution identifier. */
  readonly executionId: string;
  /** Execution environment tag matching the provider's `environment` field. */
  readonly environment: string;
  /** Full worker configuration including bus connection and workflow source. */
  readonly workerConfig: WorkflowWorkerConfig;
  /** Extension contribution manifest resolved for this worker. */
  readonly workerManifest: WorkerContributionManifest;
  /** Opaque metadata forwarded from the dispatch caller. */
  readonly metadata?: z.infer<typeof JsonObjectContractSchema>;
}

/**
 * In-process handle for a provisioned WorkerNode.
 *
 * Returned by {@link IWorkerNodeProvider.provision} and held by the caller
 * until the execution reaches a terminal state.
 */
export interface WorkerNodeHandle {
  /** Node identifier that matches the {@link WorkerNodeProvisionRequest.nodeId}. */
  readonly nodeId: string;
  /**
   * Wait for the execution to reach a terminal state.
   * @param signal - AbortSignal used to cooperatively cancel the wait.
   * @returns The final execution result.
   */
  waitForResult(signal: AbortSignal): Promise<WorkflowRunResult>;
  /**
   * Request graceful cancellation of the running execution.
   * @param reason - Optional human-readable cancellation reason.
   * @returns Promise that resolves when the cancellation request has been dispatched.
   */
  cancel(reason?: string): Promise<void>;
  /**
   * Forcibly terminate the execution environment without waiting for completion.
   * @returns Promise that resolves when the environment has been torn down.
   */
  terminate(): Promise<void>;
}

/**
 * Capability provider that can provision one-shot workflow execution nodes.
 *
 * Implementations must extend {@link ICapabilityProvider} and declare the
 * execution `environment` tag used to match dispatch requirements.
 */
export interface IWorkerNodeProvider extends ICapabilityProvider {
  /** Environment tag advertised to dispatch selectors (e.g. `'piscina'`, `'process'`). */
  readonly environment: string;
  /** Capabilities supported by this provider instance. */
  readonly baseCapabilities: WorkerNodeCapabilities;
  /**
   * Whether {@link provision} starts workflow execution before it resolves.
   *
   * Providers that set this to `true` allow dispatchers to emit
   * `worker-node.lifecycle.busy` before calling `provision()`. Providers that
   * omit it are treated as allocation-first providers, so dispatchers wait
   * until a handle exists before marking the node busy.
   */
  readonly startsExecutionDuringProvision?: boolean;
  /**
   * Provision a new isolated execution node for the given request.
   * @param request - Full provision request containing worker config and manifest.
   * @returns A handle for the provisioned node.
   */
  provision(request: WorkerNodeProvisionRequest): Promise<WorkerNodeHandle>;
}

/**
 * Framework runner dispatch seam for product hosts.
 *
 * Product hosts wire this type to their `workerPool.dispatch` implementation.
 * Framework code that needs to execute a workflow calls through this function
 * type without coupling to any pool implementation.
 * @param request - Dispatch request containing config, optional manifest, and optional requirements.
 * @param signal - AbortSignal for cooperative cancellation.
 * @returns The execution result from the dispatched worker.
 */
export type WorkerNodeDispatch = (
  request: {
    readonly config: WorkflowWorkerConfig;
    readonly manifest?: WorkerContributionManifest;
    readonly requirements?: WorkerNodeRequirements;
    readonly metadata?: z.infer<typeof JsonObjectContractSchema>;
  },
  signal: AbortSignal,
) => Promise<WorkflowRunResult>;
