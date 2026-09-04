import { z } from 'zod';
import type { ICapabilityProvider } from '../../capability/index.js';
import type { WorkflowWorkerConfig, WorkerContributionManifest } from '../../workflow/index.js';
import { JsonObjectContractSchema } from '../../shared/json-value.js';
import { SuspensionStrategySchema } from '../../worker/suspension.js';

/** Capability identifier used for Worker providers. */
export const WORKER_CAPABILITY_ID = 'worker' as const;

/**
 * Provider identifier reserved for the runtime-node built-in thin workflow provider.
 *
 * The previous Piscina Worker export name is intentionally not preserved as
 * an alias: this pre-release API must keep thin local orchestration distinct
 * from self-contained Worker providers.
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
// Bounded Recovery Evidence
// ─────────────────────────────────────────────────────────────

/**
 * Maximum lengths enforced on every {@link BoundedRecoveryEvidence} field.
 *
 * Recovery evidence is durable and is replicated into diagnostics, so its
 * size must be bounded at the contract boundary rather than by convention.
 */
export const RECOVERY_EVIDENCE_LIMITS = {
  /** Maximum length of the producing component identifier. */
  source: 128,
  /** Maximum length of the stable provider classification code. */
  code: 64,
  /** Maximum length of the human-readable summary. */
  summary: 512,
  /**
   * Maximum length of the observation timestamp.
   *
   * ISO 8601 permits an unbounded fractional-second component, so the
   * timestamp needs an explicit length bound of its own. This limit accepts
   * every realistic encoding — millisecond `Z` form, numeric offsets, and
   * nanosecond precision — while keeping the field bounded.
   */
  observedAt: 64,
} as const;

/**
 * Zod schema for bounded, durable, non-secret recovery evidence.
 *
 * Evidence explains why a provider reached a definite conclusion about an
 * allocation. It is deliberately narrow and strict: it carries a producing
 * component, a short summary, an observation timestamp, and an optional
 * stable classification code — nothing else.
 *
 * The strict object shape rejects the payloads that make durable evidence
 * unsafe or unbounded: stack traces, raw provider responses, credentials,
 * and nested error collections. Callers that hold such data must reduce it
 * to a summary before it can cross this boundary.
 */
export const BoundedRecoveryEvidenceSchema = z
  .object({
    /** Identifier of the component that observed the evidence (e.g. a provider ID). */
    source: z.string().min(1).max(RECOVERY_EVIDENCE_LIMITS.source),
    /** Short, human-readable, non-secret explanation of what was observed. */
    summary: z.string().min(1).max(RECOVERY_EVIDENCE_LIMITS.summary),
    /** ISO 8601 timestamp, with `Z` or a numeric offset, of the observation. */
    observedAt: z.iso.datetime({ offset: true }).max(RECOVERY_EVIDENCE_LIMITS.observedAt),
    /** Optional stable, machine-readable provider classification code. */
    code: z.string().min(1).max(RECOVERY_EVIDENCE_LIMITS.code).optional(),
  })
  .strict();

/**
 * Bounded, durable, non-secret evidence supporting a definite provider
 * conclusion.
 *
 * Only evidence in this shape may be persisted. The shape carries no field
 * for stacks, raw provider responses, credentials, or aggregated error
 * members, and the strict object rejects them as extra keys. It cannot
 * inspect the contents of `summary`: keeping that text short, non-secret,
 * and free of stack or response fragments is the producing provider's
 * obligation.
 */
export type BoundedRecoveryEvidence = z.infer<typeof BoundedRecoveryEvidenceSchema>;

/**
 * Stable classification code for evidence explaining that a lookup could not
 * prove exhaustiveness.
 *
 * Providers set this as {@link BoundedRecoveryEvidence.code} when a discovery
 * search could not be bounded, so neither absence nor cardinality may be
 * concluded from it. It carries no claim about whether candidates matched: a
 * search that cannot be completed proves nothing in either direction, and a
 * match observed during one is still a lower bound rather than a count.
 *
 * Consumers branch on this value rather than on a copied string literal.
 */
export const EXHAUSTIVE_SEARCH_UNAVAILABLE_CODE = 'exhaustive-search-unavailable' as const;

/**
 * Stable classification code for evidence explaining that a bounded search
 * matched no allocation.
 *
 * Distinct from {@link EXHAUSTIVE_SEARCH_UNAVAILABLE_CODE}: the search itself
 * completed, and the empty result is the observation. Whether that observation
 * proves absence is the provider's judgement, not this code's — a provider
 * whose remote listing becomes visible only after the request that created an
 * allocation is acknowledged must still report `unknown`, because an empty
 * result and a not-yet-visible allocation are indistinguishable to it.
 */
export const NO_ALLOCATION_OBSERVED_CODE = 'no-allocation-observed' as const;

/**
 * Stable classification code for evidence explaining that more than one
 * candidate allocation carried the attempt's identity.
 *
 * Discovery cannot name a single allocation in that case, so it retains
 * uncertainty instead of picking one of the candidates.
 */
export const AMBIGUOUS_ALLOCATION_MATCH_CODE = 'ambiguous-allocation-match' as const;

/**
 * Stable classification code for evidence explaining that a provision request
 * was rejected before any remote request could be issued.
 *
 * This is the only situation in which a provider can positively prove that no
 * allocation exists for an attempt, so it is also the only code that may
 * accompany a {@link WorkerConfirmedAbsentOutcome}.
 */
export const PRE_REQUEST_REJECTION_CODE = 'pre-request-rejection' as const;

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
 * allocation as reported by {@link IWorkerRecoveryCapability.inspect}.
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
 * Zod schema for the capabilities advertised by a Worker provider.
 *
 * `customCapabilities` is an open list so hosts can declare environment-
 * specific tags (e.g. `'workflow.bus-events'`) without modifying the contract.
 */
export const WorkerCapabilitiesSchema = z.object({
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
   * {@link IRecoverableWorkerProvider} and expose a
   * {@link IWorkerRecoveryCapability} object with `discoverProvisioning`,
   * `attach`, `inspect`, and `terminateAllocation` methods.
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
export type WorkerCapabilitiesInput = z.input<typeof WorkerCapabilitiesSchema>;

/** Provider capabilities advertised after schema defaults have been applied. */
export type WorkerCapabilities = z.output<typeof WorkerCapabilitiesSchema>;

/** Provider capabilities after schema defaults have been applied. */
export type NormalizedWorkerCapabilities = WorkerCapabilities;

/**
 * Zod schema for the resource requirements a workflow dispatch can express
 * during pool/provider selection.
 *
 * All fields are optional: omitted requirements impose no constraint on
 * provider selection.
 */
export const WorkerRequirementsSchema = z.object({
  /** Maximum acceptable wall-clock duration for the execution, in milliseconds. */
  maxRuntimeMs: z.number().int().positive().optional(),
  /** Whether the target environment must offer persistent storage. */
  persistentStorage: z.boolean().optional(),
  /** Capability tags that the selected provider must advertise. */
  customCapabilities: z.array(z.string().min(1)).default([]),
  /**
   * Whether the selected provider must support allocation recovery.
   *
   * When `true`, only providers whose {@link WorkerCapabilities.supportsRecovery}
   * is `true` (and that implement {@link IRecoverableWorkerProvider}) satisfy
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
   * listed modes in their {@link WorkerCapabilities.materializationModes}
   * satisfy this requirement. When omitted, materialization mode imposes
   * no constraint on provider selection.
   */
  materializationModes: z.array(MaterializationModeSchema).optional(),
});

/** Resource requirements that constrain Worker provider selection. */
export type WorkerRequirements = z.input<typeof WorkerRequirementsSchema>;

/** Resource requirements after schema defaults have been applied. */
export type NormalizedWorkerRequirements = z.output<typeof WorkerRequirementsSchema>;

// ─────────────────────────────────────────────────────────────
// Provision Request
// ─────────────────────────────────────────────────────────────

/**
 * Request handed to a Worker provider after pool dispatch has selected it.
 *
 * The Authority creates `executionAttemptId` before dispatch. Providers and
 * pools never generate it. Pool identity and resource allocation details live
 * in the host-owned dispatch layer above this contract.
 */
export interface WorkerProvisionRequest {
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
  /**
   * Non-secret ISO 8601 instant, with `Z` or a numeric offset, at which
   * provisioning for this attempt began.
   *
   * Providers that must bound a remote search use it as that search's lower
   * bound. A bound derived from the observer's clock cannot serve the same
   * purpose: an attempt older than a rolling window computes a floor that
   * excludes its own allocation, so the search can never observe it and the
   * attempt never converges.
   *
   * Required, because there is no honest substitute. Only a caller that can
   * read the attempt's durable record knows this instant, and a caller that
   * cannot read it cannot construct a provision request at all — a clock-
   * derived stand-in would reintroduce exactly the floor this field exists to
   * replace.
   */
  readonly provisioningStartedAt: string;
  /** Opaque metadata forwarded from the dispatch caller. */
  readonly metadata?: z.infer<typeof JsonObjectContractSchema>;
}

// ─────────────────────────────────────────────────────────────
// Provider Handle
// ─────────────────────────────────────────────────────────────

/**
 * Definite terminal infrastructure evidence reported by a provider.
 *
 * This is deliberately not a workflow result. Consumers use it only to end the
 * allocation's durable lifecycle when it can no longer produce an acknowledged
 * worker outcome.
 *
 * The evidence is {@link BoundedRecoveryEvidence} rather than free text because
 * a consumer that ends an allocation on this signal has to make that ending
 * durable, and only bounded evidence may be persisted. A conclusion whose
 * explanation could not cross that boundary would leave the consumer unable to
 * record why the allocation ended.
 */
export interface WorkerInfrastructureConclusion {
  /**
   * Bounded, durable, non-secret evidence describing the terminal allocation.
   *
   * Authored by the reporting provider, exactly like the evidence backing a
   * `confirmed-absent` provision outcome, and subject to the same obligation:
   * keeping the summary short, non-secret, and free of stack or raw response
   * fragments is the provider's own responsibility.
   */
  readonly evidence: BoundedRecoveryEvidence;
}

/**
 * In-process handle for a provisioned Worker allocation.
 *
 * Returned as part of the {@link IWorkerProvider.provision} result and
 * held by the caller until the allocation is no longer needed.
 *
 * The handle controls allocation infrastructure only. It does NOT expose a
 * `ready` promise or a `waitForResult()` method. Readiness is signaled
 * through the `control.attempt-ready` bus subject. Workflow outcomes are
 * submitted and acknowledged through the Authority's `control.outcome.submit`
 * bus subject.
 */
export interface WorkerHandle {
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
  observeInfrastructureConclusion?(observer: (conclusion: WorkerInfrastructureConclusion) => void): () => void;
  /**
   * Observe a refined allocation reference for this allocation.
   *
   * Providers expose this only when an allocation's identity becomes more
   * precise after provisioning returned — for example when a hosted runner's
   * run identity is only discoverable once the run has been queued.
   *
   * The provider reports the refined reference; it never persists it. Durable
   * allocation state belongs to the caller that owns the attempt's provider
   * operation, because that write is claim-fenced and the provider holds no
   * claim. If the provider already refined the reference before registration,
   * it replays the latest reference to this observer synchronously.
   * @param observer - Callback invoked with each refined allocation reference.
   * @returns Cleanup function that stops observing the provider signal.
   */
  observeAllocationRefEvolution?(observer: (nextRef: ProviderAllocationRef) => void): () => void;
}

// ─────────────────────────────────────────────────────────────
// Provider Interface
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every allocation lifetime a provider may declare.
 *
 * Source of truth for {@link WorkerAllocationLifetimeSchema} and the
 * {@link WorkerAllocationLifetime} union.
 */
export const WORKER_ALLOCATION_LIFETIMES = ['provisioner-process-bound', 'provider-managed'] as const;

/**
 * Zod schema for the lifetime of allocations created by a provider.
 *
 * - `provisioner-process-bound`: the allocation cannot outlive the process
 *   that provisioned it. When that process is gone, so is the allocation.
 * - `provider-managed`: the allocation lives in provider-owned infrastructure
 *   and survives the loss of the provisioning process, so it must be
 *   rediscovered and converged rather than assumed gone.
 */
export const WorkerAllocationLifetimeSchema = z.enum(WORKER_ALLOCATION_LIFETIMES);

/**
 * Lifetime of allocations created by a provider.
 *
 * This is a direct, intrinsic property of the provider implementation. It is
 * not placement capability data, it is never matched against dispatch
 * requirements, and it has no default: every provider states it explicitly.
 */
export type WorkerAllocationLifetime = z.infer<typeof WorkerAllocationLifetimeSchema>;

/**
 * Outcome of a provision attempt that created a provider allocation.
 */
export interface WorkerAllocatedOutcome {
  /** Discriminant for an accepted allocation. */
  readonly kind: 'allocated';
  /** Versioned, JSON-safe, non-secret allocation reference. */
  readonly allocationRef: ProviderAllocationRef;
  /** Infrastructure-only handle for the provisioned allocation. */
  readonly handle: WorkerHandle;
}

/**
 * Outcome of a provision attempt the provider positively knows created
 * nothing.
 */
export interface WorkerConfirmedAbsentOutcome {
  /** Discriminant for a provider-confirmed absence of any allocation. */
  readonly kind: 'confirmed-absent';
  /** Bounded, durable, non-secret evidence supporting the absence claim. */
  readonly evidence: BoundedRecoveryEvidence;
}

/**
 * Outcome returned by {@link IWorkerProvider.provision}.
 *
 * Only these two results are conclusions. `confirmed-absent` is a positive
 * claim a provider may make only when it knows no allocation can exist —
 * typically because the request was rejected before any remote side effect
 * could occur.
 *
 * Everything else is ambiguous and must be reported by rejecting: an untyped
 * throw, a transport error, a timeout, or an empty remote listing never
 * establish absence. Cancellation is rethrown rather than reported as an
 * outcome.
 */
export type WorkerProvisionOutcome = WorkerAllocatedOutcome | WorkerConfirmedAbsentOutcome;

/**
 * Capability provider that can provision one-shot Worker allocations for workflow execution.
 *
 * Implementations must extend {@link ICapabilityProvider} and declare the
 * execution `environment` tag used to match dispatch requirements, plus the
 * {@link WorkerAllocationLifetime} of the allocations they create.
 *
 * Provisioning accepts a cancellation signal from its first async operation.
 * The returned handle controls allocation lifecycle only; readiness and
 * outcomes travel through the bus.
 */
export interface IWorkerProvider extends ICapabilityProvider {
  /** Environment tag advertised to dispatch selectors (e.g. `'piscina'`, `'process'`). */
  readonly environment: string;
  /**
   * Lifetime of every allocation this provider creates.
   *
   * Declared directly on the provider because it governs how a lost
   * provisioner is converged, not where a workflow may be placed.
   */
  readonly allocationLifetime: WorkerAllocationLifetime;
  /** Capabilities supported by this provider instance after schema defaults are applied. */
  readonly baseCapabilities: WorkerCapabilities;
  /**
   * Provision a new isolated Worker for the given request.
   *
   * Resolves once the provider has reached a conclusion: either an accepted
   * allocation with a validated reference and infrastructure-only handle, or
   * a positively confirmed absence supported by bounded evidence. Ambiguous
   * failures reject instead of resolving.
   * @param request - Full provision request containing worker config and manifest.
   * @param signal - AbortSignal for cooperative cancellation of the provision operation.
   * @returns Allocated reference and handle, or confirmed absence with bounded evidence.
   */
  provision(request: WorkerProvisionRequest, signal: AbortSignal): Promise<WorkerProvisionOutcome>;
}

// ─────────────────────────────────────────────────────────────
// Provider Recovery Capability
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every provisioning discovery result kind.
 *
 * Source of truth for {@link ProvisioningDiscoverySchema} and the
 * {@link ProvisioningDiscovery} union.
 */
export const PROVISIONING_DISCOVERY_KINDS = ['found', 'confirmed-absent', 'unknown'] as const;

/**
 * Zod schema for the result of an exhaustive, side-effect-free lookup for an
 * allocation that may already exist for an execution attempt.
 *
 * Discovery answers one question: does an allocation for this attempt exist?
 * It has exactly three honest answers:
 *
 * - `found`: exactly one allocation matched, and its reference is returned.
 * - `confirmed-absent`: the search was exhaustive and no allocation exists.
 * - `unknown`: the search could not establish either — for example because
 *   more than one candidate matched, or exhaustiveness could not be proven.
 *
 * Provider API and transport failures reject instead of resolving, and
 * cancellation is rethrown. An empty remote listing on its own is `unknown`,
 * never `confirmed-absent`.
 *
 * Discovery never returns a handle: it observes, it does not allocate.
 */
export const ProvisioningDiscoverySchema = z.discriminatedUnion('kind', [
  z
    .object({
      /** Discriminant for a unique matched allocation. */
      kind: z.literal('found'),
      /** Validated reference to the single discovered allocation. */
      allocationRef: ProviderAllocationRefSchema,
    })
    .strict(),
  z
    .object({
      /** Discriminant for a proven absence of any allocation. */
      kind: z.literal('confirmed-absent'),
      /** Bounded, durable, non-secret evidence supporting the absence claim. */
      evidence: BoundedRecoveryEvidenceSchema,
    })
    .strict(),
  z
    .object({
      /** Discriminant for retained uncertainty. */
      kind: z.literal('unknown'),
      /** Bounded, durable, non-secret evidence describing what blocked a conclusion. */
      evidence: BoundedRecoveryEvidenceSchema,
    })
    .strict(),
]);

/**
 * Result of an exhaustive, side-effect-free lookup for an allocation that may
 * already exist for an execution attempt.
 *
 * Only `confirmed-absent` closes pre-allocation uncertainty. `unknown`
 * preserves it.
 */
export type ProvisioningDiscovery = z.infer<typeof ProvisioningDiscoverySchema>;

/**
 * Coherent recovery capability for providers that support allocation recovery.
 *
 * Recovery is one indivisible capability: a provider implements all four
 * operations (`discoverProvisioning`, `attach`, `inspect`,
 * `terminateAllocation`) or none. Partial implementation is a type error
 * because all four are required members of this interface.
 *
 * - `discoverProvisioning` is exhaustive, side-effect-free lookup by attempt.
 * - `attach` is same-attempt controller recovery, never workflow resume.
 * - `inspect` reports infrastructure evidence, never canonical workflow truth.
 * - `terminateAllocation` is idempotent; already absent is success.
 */
export interface IWorkerRecoveryCapability {
  /**
   * Search provider infrastructure for an allocation belonging to an attempt.
   *
   * Used when an allocation reference was never durably recorded, so the
   * only identity available is the attempt itself. The search must be
   * side-effect-free: it never creates, starts, stops, or deletes provider
   * resources, and it never dispatches work.
   *
   * Absence may be reported only when the search was exhaustive. Anything
   * less — an ambiguous match, an unbounded listing, or a partial scan —
   * resolves as `unknown`. Provider API and transport failures reject, and
   * cancellation is rethrown.
   * @param request - Original provision request identifying the attempt to search for.
   * @param signal - AbortSignal for cooperative cancellation of the discovery operation.
   * @returns Discovered allocation, proven absence, or retained uncertainty.
   */
  discoverProvisioning(request: WorkerProvisionRequest, signal: AbortSignal): Promise<ProvisioningDiscovery>;

  /**
   * Re-attach to an existing allocation for the same attempt.
   *
   * Creates a fresh in-process {@link WorkerHandle} without creating a
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
    request: WorkerProvisionRequest,
    signal: AbortSignal,
  ): Promise<WorkerHandle>;

  /**
   * Inspect the infrastructure state of an existing allocation.
   *
   * Returns infrastructure evidence only. A terminal allocation without an
   * acknowledged worker outcome is an infrastructure failure, not a workflow
   * success or failure. The returned {@link AllocationInspection} includes
   * the allocation state and optional non-secret provider evidence.
   * @param allocationRef - Validated allocation reference to inspect.
   * @param request - Freshly resolved provision request for the same attempt.
   * @param signal - AbortSignal for cooperative cancellation of the inspect operation.
   * @returns Infrastructure state and optional evidence for the allocation.
   */
  inspect(
    allocationRef: ProviderAllocationRef,
    request: WorkerProvisionRequest,
    signal: AbortSignal,
  ): Promise<AllocationInspection>;

  /**
   * Terminate a provider allocation by its reference.
   *
   * Idempotent: if the allocation is already absent or terminal, the call
   * succeeds without error. Providers must not throw when asked to terminate
   * a resource that no longer exists.
   * @param allocationRef - Validated allocation reference to terminate.
   * @param request - Freshly resolved provision request for the same attempt.
   * @param signal - AbortSignal for cooperative cancellation of the terminate operation.
   */
  terminateAllocation(
    allocationRef: ProviderAllocationRef,
    request: WorkerProvisionRequest,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Worker provider that supports allocation recovery.
 *
 * Extends {@link IWorkerProvider} with a required `recovery` property
 * containing the coherent {@link IWorkerRecoveryCapability}. Providers
 * that advertise `supportsRecovery: true` in their capabilities must
 * implement this interface.
 *
 * The `recovery` property is required, not optional, so that omitting any
 * of the four recovery methods is a compile-time type error.
 */
export interface IRecoverableWorkerProvider extends IWorkerProvider {
  /** Coherent recovery capability containing discovery, attach, inspect, and termination. */
  readonly recovery: IWorkerRecoveryCapability;
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
export interface WorkerDispatchAck {
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
export type WorkerDispatch = (
  request: {
    readonly executionAttemptId: string;
    readonly config: WorkflowWorkerConfig;
    readonly manifest?: WorkerContributionManifest;
    readonly requirements?: WorkerRequirements;
    readonly metadata?: z.infer<typeof JsonObjectContractSchema>;
  },
  signal: AbortSignal,
) => Promise<WorkerDispatchAck>;
