import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import { WorkerRequirementsSchema } from '../capabilities/worker/index.js';
import { OutcomeAckDecisionSchema, ProviderAllocationRefSchema } from '../capabilities/worker/types.js';
import { WorkerRuntimeInputsSchema } from './runtime-inputs.js';
import { AuthEnvironmentVariableNameSchema } from '../auth/definitions.js';
import { ExecutionAttemptBootstrapStartRefusalReasonSchema } from '../execution-attempt/schemas.js';
import {
  WorkflowRunResultSchema,
  WorkflowWorkerConfigSchema,
  WorkerContributionManifestSchema,
} from '../workflow/index.js';

const StandardBootstrapDeadlineAtSchema = z.iso.datetime({ offset: true });

/**
 * A representable bootstrap instant, including every canonical Date.toISOString
 * value a creation-time budget can produce. Offset and second-precision ISO
 * inputs remain valid; extended years use the producer's exact canonical form.
 */
export const WorkerBootstrapDeadlineAtSchema = z.string().refine((value) => {
  const instant = Date.parse(value);
  return (
    Number.isFinite(instant) &&
    (StandardBootstrapDeadlineAtSchema.safeParse(value).success || new Date(instant).toISOString() === value)
  );
}, 'Expected a representable ISO bootstrap deadline');

/** Credentials consumed by a bus connector, independent of the claim decision. */
export const WorkerBootstrapCredentialsSchema = z
  .object({
    /** WebSocket URL of the authenticated bus endpoint. */
    busUrl: z.string().min(1),
    /** Attempt-scoped HMAC secret. */
    busAuthSecret: z.string().min(1),
  })
  .strict();

/** Private payload returned only after a bootstrap claim is granted. */
export const WorkerBootstrapGrantedClaimResponseSchema = z
  .object({
    status: z.literal('granted'),
    credentials: WorkerBootstrapCredentialsSchema,
    /** Resolved private environment, never exposed by pending or refused replies. */
    runtimeEnv: z.record(AuthEnvironmentVariableNameSchema, z.string()),
  })
  .strict();

/** Non-secret refusals shared with start authorization plus remote claim eligibility. */
export const WorkerBootstrapClaimRefusalReasonSchema = z.enum([
  ...ExecutionAttemptBootstrapStartRefusalReasonSchema.options,
  'provider-mismatch',
  'claim-expired',
  'not-claimable',
]);

/** Bounded remote credential exchange; only a grant carries private material. */
export const WorkerBootstrapClaimResponseSchema = z.discriminatedUnion('status', [
  WorkerBootstrapGrantedClaimResponseSchema,
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('refused'), reason: WorkerBootstrapClaimRefusalReasonSchema }).strict(),
]);

/** Credentials for the authenticated attempt connection. */
export type WorkerBootstrapCredentials = z.infer<typeof WorkerBootstrapCredentialsSchema>;
/** Granted bootstrap claim with credentials and private Runtime environment. */
export type WorkerBootstrapGrantedClaimResponse = z.infer<typeof WorkerBootstrapGrantedClaimResponseSchema>;
/** Non-secret remote claim refusal. */
export type WorkerBootstrapClaimRefusalReason = z.infer<typeof WorkerBootstrapClaimRefusalReasonSchema>;

/**
 * Base fields present on every Worker lifecycle event.
 *
 * Pool identity is deliberately absent — pool assignment is host-owned and
 * must not leak into the framework lifecycle payload surface.
 */
const WorkerLifecycleBaseSchema = z.object({
  /** Authority-created attempt identifier for this dispatch. */
  executionAttemptId: z.string().min(1),
  /** Unique workflow execution identifier. */
  executionId: z.string().min(1),
  /** Execution environment tag (e.g. `'piscina'`, `'process'`). */
  environment: z.string().min(1),
  /** Opaque metadata forwarded from the originating dispatch caller. */
  metadata: JsonObjectContractSchema.optional(),
});

/**
 * Why an owner-authorized Cancel is still undelivered after one bounded pass.
 *
 * Every member names something a delivery pass observed *instead of* stop
 * evidence. None of them asserts that the Worker stopped, that it kept
 * running, or that its compute may be reclaimed.
 */
export const WorkerCancelUndeliveredKindSchema = z.enum([
  /** The addressed runtime did not answer the bounded delivery request. */
  'unavailable',
  /** The addressed runtime answered that it refuses cooperative stop. */
  'refused',
  /** An answer arrived that does not correlate to this delivery. */
  'invalid-receipt',
  /** A correlated receipt arrived, and the Authority refused to store it. */
  'receipt-not-recorded',
]);

/**
 * One bounded cooperative-Cancel pass that produced no stop evidence.
 *
 * This is a **control-delivery diagnostic, never a terminal state**. It reports
 * what one delivery pass did not prove and leaves the Attempt's real outcome to
 * the canonical lifecycle events. A still-running Worker whose Cancel went
 * undelivered must remain able to reach `lifecycle.completed`,
 * `lifecycle.failed` or `lifecycle.terminated` afterwards.
 *
 * That is why the subject deliberately lives under `control.`, not under
 * `lifecycle.`: `lifecycle.*` is the Worker status vocabulary, and any status
 * consumer may treat `lifecycle.failed` as terminal and ignore later
 * transitions. Reporting an undelivered Cancel there would terminalize a live
 * Worker and drop its later canonical outcome. A diagnostic under `control.`
 * is additive and stays outside the status vocabulary by construction.
 *
 * The identity fields are the Worker lifecycle identity on purpose: a consumer
 * correlates a diagnostic to the same Attempt row a lifecycle event projects.
 */
export const WorkerCancelUndeliveredSchema = WorkerLifecycleBaseSchema.extend({
  /** Which delivery outcome left the Cancel undelivered. */
  kind: WorkerCancelUndeliveredKindSchema,
  /**
   * Human-readable specifics of that outcome — a refusal reason, an Authority
   * persistence decision, or the bare observation that no stop evidence came
   * back. Free-form: consumers branch on `kind`, not on this text.
   */
  detail: z.string().min(1),
  /** ISO instant at which the pass observed the missing stop evidence. */
  observedAt: z.iso.datetime({ offset: true }),
});

/** Delivery outcome that left an owner-authorized Cancel undelivered. */
export type WorkerCancelUndeliveredKind = z.infer<typeof WorkerCancelUndeliveredKindSchema>;

/** One reported cooperative-Cancel pass that produced no stop evidence. */
export type WorkerCancelUndelivered = z.infer<typeof WorkerCancelUndeliveredSchema>;

/**
 * Framework-level Worker dispatch request.
 *
 * Pool selection and provider allocation remain caller-owned. This request is
 * the generic bus seam used by workflow-level runners that need Worker
 * execution without importing a concrete pool service.
 */
export const WorkerDispatchRequestSchema = z.object({
  /** Authority-created attempt identifier for this dispatch. */
  executionAttemptId: z.string().min(1),
  /** Full workflow worker configuration. */
  config: WorkflowWorkerConfigSchema,
  /**
   * Optional concrete manifest already resolved by the caller.
   *
   * Omit this field when the dispatch implementation should resolve the
   * applicable manifest itself. Callers that need to force an explicit empty
   * manifest should pass a manifest with `contributionRefs: []`.
   */
  manifest: WorkerContributionManifestSchema.optional(),
  /** Optional resource requirements used by the dispatch implementation. */
  requirements: WorkerRequirementsSchema.optional(),
  /** Opaque caller metadata forwarded to lifecycle and provisioning payloads. */
  metadata: JsonObjectContractSchema.optional(),
});

/**
 * Framework-level Worker dispatch response.
 *
 * Returns an allocation acknowledgment after the provider has provisioned
 * a resource and the allocation reference has been persisted. Callers
 * that need the workflow result must await it through the Authority's
 * in-process waiter (`waitForOutcome`).
 */
export const WorkerDispatchResponseSchema = z
  .object({
    executionAttemptId: z.string().min(1),
    allocationRef: ProviderAllocationRefSchema,
  })
  .strict();

/**
 * Worker lifecycle bus schemas.
 *
 * All keys map to `worker.<key>` subjects on the bus. Each subject
 * represents a discrete phase in the Worker lifecycle so listeners can react
 * selectively without receiving unrelated payloads.
 *
 * Lifecycle states in order:
 * - `lifecycle.provisioning` — dispatch has selected a provider; Worker allocation is in progress
 * - `lifecycle.booting`      — environment is initialising (importing packages, connecting to bus)
 * - `lifecycle.ready`        — projected from `execution-attempt.runtime.ready`
 * - `lifecycle.busy`         — Worker Runtime has started executing the workflow
 * - `lifecycle.completed`    — execution finished successfully
 * - `lifecycle.failed`       — execution terminated with an error
 * - `lifecycle.terminated`   — Worker environment has been torn down
 * - `lifecycle.paused`       — Worker Runtime parked at a gate and exited for later resume
 *
 * Control subjects:
 * - `control.outcome.submit` — worker submits an execution outcome for durable ACK
 * - `control.bootstrap.claim`— worker claims execution-scoped bus credentials
 * - `runtime.inputs.get` — authenticated runtime pulls its selected realization inputs
 * - `control.cancel-undelivered` — one cooperative Cancel pass produced no stop evidence
 *
 * `control.cancel-undelivered` is a delivery diagnostic, not a lifecycle state:
 * it never terminalizes a Worker and never supersedes a canonical outcome.
 */
export const WorkerSchemas = {
  /**
   * Dispatch a workflow execution to a Worker dispatcher.
   *
   * Subject: `worker.dispatch`
   * Type: Request (RPC)
   */
  dispatch: {
    request: WorkerDispatchRequestSchema,
    response: WorkerDispatchResponseSchema,
  },

  /**
   * Read the non-secret Runtime inputs selected for the authenticated Attempt.
   *
   * The host derives the execution owner from the existing authenticated peer and
   * resolves the Attempt's binding. A missing binding returns null, never current
   * defaults. Credentials remain on the existing bootstrap path.
   *
   * Subject: `worker.runtime.inputs.get`
   * Type: Request (RPC) — Worker Runtime → host
   */
  'runtime.inputs.get': {
    request: z.object({ executionAttemptId: z.string().min(1) }).strict(),
    response: z.object({ runtimeInputs: WorkerRuntimeInputsSchema.nullable() }).strict(),
  },

  /**
   * Worker submits a terminal workflow outcome for durable acknowledgement.
   *
   * The Authority validates the attempt, commits the outcome through the
   * injected repository, and returns an ACK decision. Workers must not
   * exit until they receive the ACK.
   *
   * Subject: `worker.control.outcome.submit`
   * Type: Request (RPC)
   */
  'control.outcome.submit': {
    request: z
      .object({
        /** Authority-created attempt identifier. */
        executionAttemptId: z.string().min(1),
        /** Workflow execution identifier. */
        executionId: z.string().min(1),
        /** Terminal result produced by the isolated workflow runner. */
        result: WorkflowRunResultSchema,
      })
      .strict()
      .superRefine((payload, ctx) => {
        if (payload.result.executionId !== payload.executionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['result', 'executionId'],
            message: 'result.executionId must match executionId',
          });
        }
      }),
    response: z
      .object({
        /** Durable ACK decision from the Authority. */
        decision: OutcomeAckDecisionSchema,
      })
      .strict(),
  },

  /**
   * Worker claims its execution-scoped bus credentials during bootstrap.
   *
   * The Worker Runtime authenticates its WebSocket connection as a bootstrap peer, then
   * presents its execution/attempt identity. The server validates that trusted
   * transport identity and the durable allocation before exchanging it for an
   * execution-scoped `busAuthSecret` used for subsequent communication.
   *
   * Subject: `worker.control.bootstrap.claim`
   * Type: Request (RPC)
   */
  'control.bootstrap.claim': {
    request: z
      .object({
        /** Unique workflow execution identifier assigned to this worker. */
        executionId: z.string().min(1),
        /** Authority-created attempt identifier. */
        executionAttemptId: z.string().min(1),
      })
      .strict(),
    response: WorkerBootstrapClaimResponseSchema,
  },

  /**
   * One bounded cooperative-Cancel delivery pass produced no stop evidence.
   *
   * Emitted by the party that owns delivery of an owner-authorized Cancel, once
   * per pass that ended without evidence that the addressed runtime stopped. It
   * is the only channel that makes that absence visible, and it reports a
   * delivery fact only: never a Worker state, and never permission to reclaim
   * the Worker's compute.
   *
   * Not a lifecycle subject by design — see
   * {@link WorkerCancelUndeliveredSchema}. Status projections consume
   * `lifecycle.*` and must stay unaffected by this diagnostic.
   *
   * Subject: `worker.control.cancel-undelivered`
   * Type: Event (notification; no reply)
   */
  'control.cancel-undelivered': WorkerCancelUndeliveredSchema,

  /**
   * Dispatch has selected a provider; Worker allocation is in progress.
   *
   * Subject: `worker.lifecycle.provisioning`
   * Type: Event
   */
  'lifecycle.provisioning': WorkerLifecycleBaseSchema,

  /**
   * Environment is initialising (importing packages, connecting to bus).
   *
   * Subject: `worker.lifecycle.booting`
   * Type: Event
   */
  'lifecycle.booting': WorkerLifecycleBaseSchema,

  /**
   * Worker Runtime is connected and ready to accept work.
   *
   * Projected by the worker pool from `execution-attempt.runtime.ready`, which is
   * the subject that carries the proven runtime endpoint. This event stays a plain
   * lifecycle payload: adapter composition is a workflow-runtime concern and is not
   * part of the readiness surface.
   *
   * Subject: `worker.lifecycle.ready`
   * Type: Event
   */
  'lifecycle.ready': WorkerLifecycleBaseSchema,

  /**
   * Worker Runtime has started executing the workflow.
   *
   * Subject: `worker.lifecycle.busy`
   * Type: Event
   */
  'lifecycle.busy': WorkerLifecycleBaseSchema,

  /**
   * Execution finished successfully.
   *
   * Subject: `worker.lifecycle.completed`
   * Type: Event
   */
  'lifecycle.completed': WorkerLifecycleBaseSchema,

  /**
   * Execution terminated with an error.
   *
   * Subject: `worker.lifecycle.failed`
   * Type: Event
   */
  'lifecycle.failed': WorkerLifecycleBaseSchema.extend({
    /** Human-readable error message describing the failure. */
    error: z.string().min(1),
  }),

  /**
   * Worker environment has been torn down.
   *
   * Subject: `worker.lifecycle.terminated`
   * Type: Event
   */
  'lifecycle.terminated': WorkerLifecycleBaseSchema.extend({
    /** Optional reason for termination (e.g. `'cancelled'`, `'timeout'`). */
    reason: z.string().optional(),
  }),

  /**
   * Worker has suspended at a gate and the Worker Runtime has exited.
   *
   * Emitted by providers using `exit-and-redispatch` or `exit-and-resume`
   * suspension strategies before the environment tears down. In-process
   * providers that block at the gate do not emit this event.
   *
   * Subject: `worker.lifecycle.paused`
   * Type: Event
   */
  'lifecycle.paused': WorkerLifecycleBaseSchema.extend({
    /** Node ID of the gate at which execution paused. */
    pausedAtGateId: z.string().min(1),
    /** Frame ID of the suspended gate instance. */
    pausedAtFrameId: z.string().min(1),
  }),
} satisfies SchemaRecord;

/** Bootstrap coordinates presented by a remote worker. */
export type WorkerBootstrapClaimRequest = z.infer<(typeof WorkerSchemas)['control.bootstrap.claim']['request']>;

/** Granted private material, a renewable pending reply, or a non-secret refusal. */
export type WorkerBootstrapClaimResponse = z.infer<(typeof WorkerSchemas)['control.bootstrap.claim']['response']>;

/** Authenticated runtime query for its Attempt's selected realization inputs. */
export type WorkerRuntimeInputsGetRequest = z.infer<(typeof WorkerSchemas)['runtime.inputs.get']['request']>;

/** Bound Runtime inputs, or null when this Attempt has no selected binding. */
export type WorkerRuntimeInputsGetResponse = z.infer<(typeof WorkerSchemas)['runtime.inputs.get']['response']>;
