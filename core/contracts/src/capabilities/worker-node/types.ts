import { z } from 'zod';
import type { ICapabilityProvider } from '../../capability/index.js';
import type { WorkflowRunResult, WorkflowWorkerConfig, WorkerContributionManifest } from '../../workflow/index.js';
import { JsonObjectContractSchema } from '../../shared/json-value.js';

/** Capability identifier used for WorkerNode providers. */
export const WORKER_NODE_CAPABILITY_ID = 'worker-node' as const;

/**
 * Provider identifier reserved for the runtime-node built-in thin workflow provider.
 *
 * The previous Piscina WorkerNode export name is intentionally not preserved as
 * an alias: this pre-release API must keep thin local orchestration distinct
 * from self-contained WorkerNode providers.
 */
export const BUILT_IN_THIN_WORKFLOW_PROVIDER_ID = 'makaio.runtime-node.piscina-local' as const;

/**
 * Zod schema for the capabilities advertised by a WorkerNode provider.
 *
 * `customCapabilities` is an open list so hosts can declare environment-
 * specific tags (e.g. `'workflow.bus-events'`) without modifying the contract.
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
 * allocation details live in the host-owned dispatch layer above this contract.
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

/** Readiness details reported by a provisioned WorkerNode. */
export interface WorkerNodeReadyState {
  /** Adapter identifiers loaded inside the WorkerNode before it became ready. */
  readonly adapters?: readonly string[];
}

/**
 * In-process handle for a provisioned WorkerNode.
 *
 * Returned by {@link IWorkerNodeProvider.provision} and held by the caller
 * until the execution reaches a terminal state.
 *
 * Readiness contract: `provision()` resolves once the provider has accepted
 * the execution request and returned a cancellable handle. Providers that can
 * observe when their worker environment is connected and ready to receive
 * control messages (e.g. cancel, gate signals over the bus) should expose
 * the optional {@link ready} promise. Callers that need to gate downstream
 * work — such as emitting `lifecycle.ready` events — should await
 * {@link ready} before proceeding. If {@link ready} is absent the caller
 * must treat the handle as immediately ready.
 *
 * Cancellation during the readiness window: if a dispatch cancel signal or
 * workflow cancel event arrives while awaiting {@link ready}, the handle
 * must still be cancelled via {@link cancel} or {@link terminate}. The
 * readiness wait itself is not a cancellation barrier.
 */
export interface WorkerNodeHandle {
  /** Node identifier that matches the {@link WorkerNodeProvisionRequest.nodeId}. */
  readonly nodeId: string;
  /**
   * Optional promise that resolves when the worker environment is connected
   * and ready to receive control messages such as cancel or gate signals.
   *
   * Absent on providers where the execution environment is ready
   * synchronously (e.g. in-process Piscina threads). Present on providers
   * where the environment must boot asynchronously before it can observe bus
   * messages (e.g. remote process, container, WebSocket-connected worker).
   *
   * Callers must still honour the dispatch cancellation signal while
   * awaiting this promise and cancel any late handle that resolves after
   * cancellation has been requested.
   */
  readonly ready?: Promise<void | WorkerNodeReadyState>;
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
   * Provision a new isolated execution node for the given request.
   *
   * Resolves once the provider has accepted the execution request and
   * returned a cancellable handle. The returned handle may expose an
   * optional {@link WorkerNodeHandle.ready} promise for providers that boot
   * asynchronously; callers should await it before treating the node as
   * ready to receive control messages.
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
