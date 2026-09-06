import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import { WorkerRequirementsSchema } from '../capabilities/worker/index.js';
import { OutcomeAckDecisionSchema, ProviderAllocationRefSchema } from '../capabilities/worker/types.js';
import {
  WorkflowRunResultSchema,
  WorkflowWorkerConfigSchema,
  WorkerContributionManifestSchema,
} from '../workflow/index.js';

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
    response: z
      .object({
        /** WebSocket URL of the bus server the Worker Runtime should connect to. */
        busUrl: z.string().min(1),
        /**
         * Execution-scoped HMAC secret for authenticating subsequent bus
         * messages.
         */
        busAuthSecret: z.string().min(1),
      })
      .strict(),
  },

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

/** Execution-scoped credentials issued after a successful bootstrap claim. */
export type WorkerBootstrapClaimResponse = z.infer<(typeof WorkerSchemas)['control.bootstrap.claim']['response']>;
