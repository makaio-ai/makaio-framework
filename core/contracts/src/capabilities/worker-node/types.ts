import { z } from 'zod';
import type { ICapabilityProvider } from '../../capability/index.js';
import type { WorkflowWorkerConfig, WorkerContributionManifest } from '../../workflow/index.js';
import { JsonObjectContractSchema } from '../../shared/json-value.js';
import { SuspensionStrategySchema } from '../../worker-node/suspension.js';

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

// ─────────────────────────────────────────────────────────────
// Provider Allocation Reference
// ─────────────────────────────────────────────────────────────

/**
 * Current envelope version for provider allocation references.
 *
 * Bump when the envelope shape changes so consumers can migrate
 * serialized references across releases.
 */
export const PROVIDER_ALLOCATION_REF_VERSION = 1 as const;

/**
 * Zod schema for a versioned, JSON-safe, non-secret provider allocation reference.
 *
 * Every accepted remote allocation produces one of these. The envelope carries
 * a version tag so consumers can detect format drift in serialized references,
 * and a `providerId` so the correct provider can validate or rehydrate the
 * opaque `providerData` without trial-and-error.
 *
 * `providerData` is an opaque JSON object whose structure is provider-defined.
 * Framework code never inspects it; only the originating provider interprets it.
 */
export const ProviderAllocationRefSchema = z
  .object({
    /** Envelope format version. Always {@link PROVIDER_ALLOCATION_REF_VERSION}. */
    version: z.literal(PROVIDER_ALLOCATION_REF_VERSION),
    /** Provider identifier that created this allocation. */
    providerId: z.string().min(1),
    /** Opaque provider-specific allocation data. */
    providerData: JsonObjectContractSchema,
  })
  .strict();

/** Versioned, JSON-safe, non-secret provider allocation reference. */
export type ProviderAllocationRef = z.infer<typeof ProviderAllocationRefSchema>;

// ─────────────────────────────────────────────────────────────
// Allocation State And Inspection
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of all allocation lifecycle states.
 *
 * Used as the source of truth for the {@link AllocationStateSchema} and the
 * {@link AllocationState} union type.
 */
export const ALLOCATION_STATES = [
  'unknown',
  'provisioning',
  'ready',
  'running',
  'suspended',
  'terminal',
  'absent',
] as const;

/**
 * Zod schema for provider allocation lifecycle states.
 *
 * These states describe the infrastructure-level lifecycle of a provider
 * allocation as reported by {@link IWorkerNodeRecoveryCapability.inspect}.
 * They are infrastructure evidence, never canonical workflow truth:
 *
 * - `unknown`: the provider cannot determine the current state.
 * - `provisioning`: the allocation resource is being created.
 * - `ready`: the resource exists and is waiting for the worker to start.
 * - `running`: the worker process is executing inside the allocation.
 * - `suspended`: the allocation is parked (e.g. Fly machine stopped).
 * - `terminal`: the allocation has exited and will not run again.
 * - `absent`: the allocation resource no longer exists at the provider.
 */
export const AllocationStateSchema = z.enum(ALLOCATION_STATES);

/**
 * Infrastructure-level allocation lifecycle state.
 *
 * Reported by provider inspection. Never substitutes for canonical workflow
 * outcome truth held by the Authority.
 */
export type AllocationState = z.infer<typeof AllocationStateSchema>;

/**
 * Zod schema for the result of inspecting a provider allocation.
 *
 * Contains the infrastructure state, the allocation reference that was
 * inspected, and optional non-secret provider evidence (e.g. exit code,
 * timestamps, termination reason).
 *
 * Framework code treats `evidence` as opaque; only the originating provider
 * interprets its contents.
 */
export const AllocationInspectionSchema = z.object({
  /** Current infrastructure lifecycle state of the allocation. */
  state: AllocationStateSchema,
  /** The allocation reference that was inspected. */
  allocationRef: ProviderAllocationRefSchema,
  /**
   * Optional non-secret provider evidence about the allocation.
   *
   * May include exit codes, timestamps, termination reasons, or other
   * infrastructure details. Framework code never interprets this; only
   * the originating provider assigns meaning to the contents.
   */
  evidence: JsonObjectContractSchema.optional(),
});

/**
 * Result of inspecting a provider allocation.
 *
 * Reports infrastructure evidence only. A terminal allocation without an
 * acknowledged worker outcome is an infrastructure failure, not a workflow
 * success or failure.
 */
export type AllocationInspection = z.infer<typeof AllocationInspectionSchema>;

// ─────────────────────────────────────────────────────────────
// Worker Materialization Spec
// ─────────────────────────────────────────────────────────────

/**
 * Constant array of all supported materialization mode discriminants.
 *
 * Used as the source of truth for the {@link MaterializationModeSchema}
 * and the provider capabilities / requirements materialization mode fields.
 */
export const MATERIALIZATION_MODES = ['local-directory', 'workspace-snapshot'] as const;

/**
 * Zod schema for a materialization mode discriminant.
 *
 * Reused in requirements and capabilities to express supported modes.
 */
export const MaterializationModeSchema = z.enum(MATERIALIZATION_MODES);

/** Materialization mode discriminant string union. */
export type MaterializationMode = z.infer<typeof MaterializationModeSchema>;

/**
 * Zod schema for a workspace-relative source path.
 *
 * A relative source path must be non-empty and must not start with `/`
 * or a Windows drive letter (e.g. `C:\`). Absolute paths are
 * Authority-local and must never appear in durable portable state.
 */
const RelativeSourcePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(p), {
    message: 'sourcePath must be relative (no leading / or drive letter)',
  });

/**
 * Zod schema for a local-directory materialization spec.
 *
 * Used when the workspace is already available on the same filesystem
 * as the worker (e.g. Piscina thread pool, local process).
 *
 * `sourcePath` is workspace-relative so the spec remains portable
 * across machines. The materializer combines it with the resolved
 * workspace root at realization time.
 */
export const LocalDirectoryMaterializationSchema = z
  .object({
    /** Discriminant for local-directory materialization. */
    kind: z.literal('local-directory'),
    /** Workspace identity for product-owned resolution. */
    workspaceId: z.string().min(1),
    /** Content-addressable digest of the workspace root. */
    rootDigest: z.string().min(1),
    /** Workspace-relative path to the workflow source. */
    sourcePath: RelativeSourcePathSchema,
  })
  .strict();

/**
 * Zod schema for a workspace-snapshot materialization spec.
 *
 * Used when the workspace must be fetched as an immutable, digest-verified
 * snapshot (e.g. remote workers, containers, CI runners).
 */
export const WorkspaceSnapshotMaterializationSchema = z
  .object({
    /** Discriminant for workspace-snapshot materialization. */
    kind: z.literal('workspace-snapshot'),
    /** Unique identifier for the snapshot artifact. */
    snapshotId: z.string().min(1),
    /** Content-addressable digest of the snapshot. */
    digest: z.string().min(1),
    /** Relative source path within the snapshot. */
    sourcePath: RelativeSourcePathSchema,
  })
  .strict();

/**
 * Zod schema for the portable worker materialization specification.
 *
 * Discriminated on `kind`:
 * - `local-directory`: workspace is on the same filesystem as the worker
 * - `workspace-snapshot`: workspace must be fetched as an immutable snapshot
 *
 * Two realizations ship with the framework: a local-directory materializer
 * (same-filesystem placement for in-process and local-container runners) and a
 * workspace-snapshot materializer (remote immutable snapshot fetch for
 * hosted runners). Additional materializers can be supplied by host seams
 * without changes to these discriminants.
 */
export const WorkerMaterializationSpecSchema = z.discriminatedUnion('kind', [
  LocalDirectoryMaterializationSchema,
  WorkspaceSnapshotMaterializationSchema,
]);

/**
 * Portable worker materialization specification.
 *
 * Tells a worker how to obtain its workspace contents. The two modes
 * cover local same-filesystem placement and remote immutable snapshots.
 */
export type WorkerMaterializationSpec = z.infer<typeof WorkerMaterializationSpecSchema>;

// ─────────────────────────────────────────────────────────────
// Worker Contribution Reference
// ─────────────────────────────────────────────────────────────

/**
 * Regex pattern for Subresource Integrity (SRI) hashes.
 *
 * Matches `sha256-`, `sha384-`, or `sha512-` followed by one or more
 * base64 characters. This is the W3C SRI format used by browsers and
 * npm for content integrity verification.
 */
const SRI_INTEGRITY_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/;

/**
 * Zod schema for a contribution reference with exact package identity.
 *
 * Contribution references carry the package name, version, entrypoint, and
 * integrity hash of the complete installed package artifact needed to load a
 * worker-local extension package. They never
 * carry `node_modules` paths. The entrypoint is a package-relative path
 * (e.g. `dist/server.mjs`), never an absolute or `node_modules` path.
 * The integrity hash must be a valid W3C Subresource Integrity string.
 */
export const WorkerContributionRefSchema = z
  .object({
    /** Package name (e.g. `'@acme/workflow-tools'`). */
    packageName: z.string().min(1),
    /** Exact package version (e.g. `'1.2.3'`). */
    version: z.string().min(1),
    /**
     * Package-relative entrypoint path (e.g. `'dist/server.mjs'`).
     *
     * Must not reference `node_modules` — contribution entrypoints are
     * package-relative, not installation-relative.
     */
    entrypoint: z
      .string()
      .min(1)
      .refine((p) => !p.includes('node_modules') && !p.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(p), {
        message: 'entrypoint must be package-relative (no node_modules, no absolute path)',
      }),
    /**
     * Subresource integrity hash of complete package contents (e.g.
     * `'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/...'`).
     *
     * Must match the W3C SRI format: `sha{256|384|512}-<base64>`.
     */
    integrity: z
      .string()
      .min(1)
      .refine((v) => SRI_INTEGRITY_PATTERN.test(v), {
        message: 'integrity must be a valid SRI hash (sha256-..., sha384-..., or sha512-...)',
      }),
  })
  .strict();

/** Exact contribution identity reference for a worker-local extension package. */
export type WorkerContributionRef = z.infer<typeof WorkerContributionRefSchema>;

// ─────────────────────────────────────────────────────────────
// Capabilities and Requirements
// ─────────────────────────────────────────────────────────────

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
  /**
   * Suspension behavior this provider uses when a workflow reaches a gate.
   *
   * Defaults to `'wait-in-process'` for providers that block in-place
   * (e.g. local Piscina threads). Providers that exit and redispatch or
   * exit and resume on a managed environment must declare the appropriate
   * strategy here so dispatchers can select the right gate-parking path.
   */
  suspensionStrategy: SuspensionStrategySchema.default('wait-in-process'),
  /**
   * Whether this provider supports allocation recovery.
   *
   * Providers that advertise `true` must implement
   * {@link IRecoverableWorkerNodeProvider} and expose a
   * {@link IWorkerNodeRecoveryCapability} object with `attach`, `inspect`,
   * and `terminateAllocation` methods.
   *
   * Defaults to `false`. Non-recoverable providers (e.g. Piscina) leave
   * this at the default.
   */
  supportsRecovery: z.boolean().default(false),
  /**
   * Materialization modes this provider supports.
   *
   * Each entry is a {@link MaterializationMode} discriminant. Dispatchers
   * match the workflow's required mode against this list to select a
   * compatible provider.
   *
   * Defaults to `['local-directory']` — the mode supported by all
   * same-filesystem providers (e.g. Piscina).
   */
  materializationModes: z.array(MaterializationModeSchema).min(1).default(['local-directory']),
});

/** Raw provider capability input accepted before schema defaults are applied. */
export type WorkerNodeCapabilitiesInput = z.input<typeof WorkerNodeCapabilitiesSchema>;

/** Provider capabilities advertised after schema defaults have been applied. */
export type WorkerNodeCapabilities = z.output<typeof WorkerNodeCapabilitiesSchema>;

/** Provider capabilities after schema defaults have been applied. */
export type NormalizedWorkerNodeCapabilities = WorkerNodeCapabilities;

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
  /**
   * Whether the selected provider must support allocation recovery.
   *
   * When `true`, only providers whose {@link WorkerNodeCapabilities.supportsRecovery}
   * is `true` (and that implement {@link IRecoverableWorkerNodeProvider}) satisfy
   * this requirement.
   *
   * When omitted or `false`, recovery support is not required and any
   * provider may be selected.
   */
  recoverableAllocation: z.boolean().optional(),
  /**
   * Materialization modes the dispatch requires the provider to support.
   *
   * When specified, only providers that advertise at least one of the
   * listed modes in their {@link WorkerNodeCapabilities.materializationModes}
   * satisfy this requirement. When omitted, materialization mode imposes
   * no constraint on provider selection.
   */
  materializationModes: z.array(MaterializationModeSchema).optional(),
});

/** Resource requirements that constrain WorkerNode provider selection. */
export type WorkerNodeRequirements = z.input<typeof WorkerNodeRequirementsSchema>;

/** Resource requirements after schema defaults have been applied. */
export type NormalizedWorkerNodeRequirements = z.output<typeof WorkerNodeRequirementsSchema>;

// ─────────────────────────────────────────────────────────────
// Provision Request
// ─────────────────────────────────────────────────────────────

/**
 * Request handed to a WorkerNode provider after pool dispatch has selected it.
 *
 * The Authority creates `executionAttemptId` before dispatch. Providers and
 * pools never generate it. Pool identity and resource allocation details live
 * in the host-owned dispatch layer above this contract.
 */
export interface WorkerNodeProvisionRequest {
  /** Unique workflow execution identifier. */
  readonly executionId: string;
  /** Authority-created attempt identifier for this dispatch. */
  readonly executionAttemptId: string;
  /** Execution environment tag matching the provider's `environment` field. */
  readonly environment: string;
  /** Full worker configuration including bus connection and workflow source. */
  readonly workerConfig: WorkflowWorkerConfig;
  /** Extension contribution manifest resolved for this worker. */
  readonly workerManifest: WorkerContributionManifest;
  /** Opaque metadata forwarded from the dispatch caller. */
  readonly metadata?: z.infer<typeof JsonObjectContractSchema>;
}

// ─────────────────────────────────────────────────────────────
// Provider Handle
// ─────────────────────────────────────────────────────────────

/**
 * Definite terminal infrastructure evidence reported by a provider.
 *
 * This is deliberately not a workflow result. Consumers use it only to race
 * the Authority's durable outcome decision when the allocation can no longer
 * produce an acknowledged worker outcome.
 */
export interface WorkerNodeInfrastructureConclusion {
  /** Human-readable provider evidence describing the terminal allocation. */
  readonly message: string;
}

/**
 * In-process handle for a provisioned WorkerNode allocation.
 *
 * Returned as part of the {@link IWorkerNodeProvider.provision} result and
 * held by the caller until the allocation is no longer needed.
 *
 * The handle controls allocation infrastructure only. It does NOT expose a
 * `ready` promise or a `waitForResult()` method. Readiness is signaled
 * through the `control.attempt-ready` bus subject. Workflow outcomes are
 * submitted and acknowledged through the Authority's `control.outcome.submit`
 * bus subject.
 */
export interface WorkerNodeHandle {
  /** Authority-created attempt identifier for this allocation. */
  readonly executionAttemptId: string;
  /**
   * Request graceful cancellation of the allocated execution environment.
   * @param reason - Optional human-readable cancellation reason.
   * @returns Promise that resolves when the cancellation request has been dispatched.
   */
  cancel(reason?: string): Promise<void>;
  /**
   * Forcibly terminate the execution environment without waiting for completion.
   * @returns Promise that resolves when the environment has been torn down.
   */
  terminate(): Promise<void>;
  /**
   * Release provider-owned resources associated with this allocation.
   *
   * Called after the workflow outcome has settled (success, failure, or
   * cancellation) to free credentials, listeners, and other per-allocation
   * state that should not persist for the lifetime of the host process.
   *
   * Release is a resource-disposal signal, distinct from infrastructure
   * cancellation: it must NOT cancel a running allocation or alter the
   * workflow outcome. Implementations must be idempotent — calling
   * `release()` multiple times is safe and has no additional effect.
   * @returns Promise that resolves when provider resources have been released.
   */
  release(): Promise<void>;
  /**
   * Observe definite terminal infrastructure evidence for this allocation.
   *
   * Providers expose this only when they can observe a terminal allocation
   * state. The callback never carries readiness or a workflow result.
   * If the provider reached a conclusion before registration, it replays that
   * same conclusion to this observer synchronously. Each observer receives at
   * most one conclusion.
   * @param observer - Callback invoked at most once for a terminal conclusion.
   * @returns Cleanup function that stops observing the provider signal.
   */
  observeInfrastructureConclusion?(observer: (conclusion: WorkerNodeInfrastructureConclusion) => void): () => void;
}

// ─────────────────────────────────────────────────────────────
// Provider Interface
// ─────────────────────────────────────────────────────────────

/**
 * Result returned by {@link IWorkerNodeProvider.provision}.
 *
 * Contains the validated allocation reference and an infrastructure handle.
 */
export interface WorkerNodeProvisionResult {
  /** Versioned, JSON-safe, non-secret allocation reference. */
  readonly allocationRef: ProviderAllocationRef;
  /** Infrastructure-only handle for the provisioned allocation. */
  readonly handle: WorkerNodeHandle;
}

/**
 * Capability provider that can provision one-shot workflow execution nodes.
 *
 * Implementations must extend {@link ICapabilityProvider} and declare the
 * execution `environment` tag used to match dispatch requirements.
 *
 * Provisioning accepts a cancellation signal from its first async operation.
 * The returned handle controls allocation lifecycle only; readiness and
 * outcomes travel through the bus.
 */
export interface IWorkerNodeProvider extends ICapabilityProvider {
  /** Environment tag advertised to dispatch selectors (e.g. `'piscina'`, `'process'`). */
  readonly environment: string;
  /** Capabilities supported by this provider instance after schema defaults are applied. */
  readonly baseCapabilities: WorkerNodeCapabilities;
  /**
   * Provision a new isolated execution node for the given request.
   *
   * Resolves once the provider has accepted the execution request and
   * created a resource allocation. The returned result contains a validated
   * allocation reference and an infrastructure-only handle.
   * @param request - Full provision request containing worker config and manifest.
   * @param signal - AbortSignal for cooperative cancellation of the provision operation.
   * @returns Allocation reference and infrastructure handle.
   */
  provision(request: WorkerNodeProvisionRequest, signal: AbortSignal): Promise<WorkerNodeProvisionResult>;
}

// ─────────────────────────────────────────────────────────────
// Provider Recovery Capability
// ─────────────────────────────────────────────────────────────

/**
 * Coherent recovery capability for providers that support allocation recovery.
 *
 * Recovery is one indivisible capability: a provider implements all three
 * operations (`attach`, `inspect`, `terminateAllocation`) or none. Partial
 * implementation is a type error because all three are required members of
 * this interface.
 *
 * - `attach` is same-attempt controller recovery, never workflow resume.
 * - `inspect` reports infrastructure evidence, never canonical workflow truth.
 * - `terminateAllocation` is idempotent; already absent is success.
 */
export interface IWorkerNodeRecoveryCapability {
  /**
   * Re-attach to an existing allocation for the same attempt.
   *
   * Creates a fresh in-process {@link WorkerNodeHandle} without creating a
   * new provider resource. Used after an Authority restart to regain
   * infrastructure control of a still-running allocation.
   *
   * This is same-attempt controller recovery, not workflow resume. The
   * returned handle controls the same allocation that was originally
   * provisioned.
   * @param allocationRef - Validated allocation reference from a prior provision.
   * @param request - Original provision request (for provider-side correlation).
   * @param signal - AbortSignal for cooperative cancellation of the attach operation.
   * @returns Fresh infrastructure handle for the existing allocation.
   */
  attach(
    allocationRef: ProviderAllocationRef,
    request: WorkerNodeProvisionRequest,
    signal: AbortSignal,
  ): Promise<WorkerNodeHandle>;

  /**
   * Inspect the infrastructure state of an existing allocation.
   *
   * Returns infrastructure evidence only. A terminal allocation without an
   * acknowledged worker outcome is an infrastructure failure, not a workflow
   * success or failure. The returned {@link AllocationInspection} includes
   * the allocation state and optional non-secret provider evidence.
   * @param allocationRef - Validated allocation reference to inspect.
   * @param signal - AbortSignal for cooperative cancellation of the inspect operation.
   * @returns Infrastructure state and optional evidence for the allocation.
   */
  inspect(allocationRef: ProviderAllocationRef, signal: AbortSignal): Promise<AllocationInspection>;

  /**
   * Terminate a provider allocation by its reference.
   *
   * Idempotent: if the allocation is already absent or terminal, the call
   * succeeds without error. Providers must not throw when asked to terminate
   * a resource that no longer exists.
   * @param allocationRef - Validated allocation reference to terminate.
   * @param signal - AbortSignal for cooperative cancellation of the terminate operation.
   */
  terminateAllocation(allocationRef: ProviderAllocationRef, signal: AbortSignal): Promise<void>;
}

/**
 * WorkerNode provider that supports allocation recovery.
 *
 * Extends {@link IWorkerNodeProvider} with a required `recovery` property
 * containing the coherent {@link IWorkerNodeRecoveryCapability}. Providers
 * that advertise `supportsRecovery: true` in their capabilities must
 * implement this interface.
 *
 * The `recovery` property is required, not optional, so that omitting any
 * of the three recovery methods is a compile-time type error.
 */
export interface IRecoverableWorkerNodeProvider extends IWorkerNodeProvider {
  /** Coherent recovery capability containing attach, inspect, and terminateAllocation. */
  readonly recovery: IWorkerNodeRecoveryCapability;
}

// ─────────────────────────────────────────────────────────────
// Outcome ACK Decisions
// ─────────────────────────────────────────────────────────────

/**
 * Durable ACK decisions returned by the Authority when a worker submits
 * a workflow outcome.
 *
 * - `accepted`: the outcome was committed as canonical.
 * - `duplicate`: an identical outcome was already committed; this is a replay.
 * - `conflict`: a different outcome was already committed for this attempt.
 * - `fenced`: the attempt is no longer the active attempt for this execution.
 */
export type OutcomeAckDecision = 'accepted' | 'duplicate' | 'conflict' | 'fenced';

/**
 * Zod schema for outcome ACK decisions.
 */
export const OutcomeAckDecisionSchema = z.enum(['accepted', 'duplicate', 'conflict', 'fenced']);

// ─────────────────────────────────────────────────────────────
// Dispatch Acknowledgment
// ─────────────────────────────────────────────────────────────

/**
 * Allocation acknowledgment returned by the dispatch RPC.
 *
 * Dispatch returns after allocation persistence, not after the workflow
 * completes. The ack carries the attempt ID and the persisted allocation
 * reference so callers can correlate the allocation with later lifecycle
 * and outcome events.
 */
export interface WorkerNodeDispatchAck {
  /** Authority-created attempt identifier for this allocation. */
  readonly executionAttemptId: string;
  /** Provider allocation reference persisted through the Authority. */
  readonly allocationRef: ProviderAllocationRef;
}

// ─────────────────────────────────────────────────────────────
// Dispatch Seam
// ─────────────────────────────────────────────────────────────

/**
 * Framework runner dispatch seam for product hosts.
 *
 * Product hosts wire this type to their `workerPool.dispatch` implementation.
 * Framework code that needs to execute a workflow calls through this function
 * type without coupling to any pool implementation.
 *
 * The dispatch function returns an allocation acknowledgment after the
 * provider has provisioned a resource and the allocation reference has been
 * persisted. Callers that need the workflow result must await it through the
 * Authority's in-process waiter (`waitForOutcome`).
 * @param request - Dispatch request containing config, optional manifest, optional requirements,
 *   and the Authority-created attempt identifier.
 * @param signal - AbortSignal for cooperative cancellation.
 * @returns Allocation acknowledgment after provider provisioning succeeds.
 */
export type WorkerNodeDispatch = (
  request: {
    readonly executionAttemptId: string;
    readonly config: WorkflowWorkerConfig;
    readonly manifest?: WorkerContributionManifest;
    readonly requirements?: WorkerNodeRequirements;
    readonly metadata?: z.infer<typeof JsonObjectContractSchema>;
  },
  signal: AbortSignal,
) => Promise<WorkerNodeDispatchAck>;
