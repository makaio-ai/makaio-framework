import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import { WorkerNodeRequirementsSchema } from '../capabilities/worker-node/index.js';
import { OutcomeAckDecisionSchema, ProviderAllocationRefSchema } from '../capabilities/worker-node/types.js';
import {
  WorkflowRunResultSchema,
  WorkflowWorkerConfigSchema,
  WorkerContributionManifestSchema,
} from '../workflow/index.js';

/**
 * Base fields present on every WorkerNode lifecycle event.
 *
 * Pool identity is deliberately absent — pool assignment is host-owned and
 * must not leak into the framework lifecycle payload surface.
 */
const WorkerNodeLifecycleBaseSchema = z.object({
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
 * Framework-level WorkerNode dispatch request.
 *
 * Pool selection and provider allocation remain caller-owned. This request is
 * the generic bus seam used by workflow-level runners that need WorkerNode
 * execution without importing a concrete pool service.
 */
export const WorkerNodeDispatchRequestSchema = z.object({
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
  requirements: WorkerNodeRequirementsSchema.optional(),
  /** Opaque caller metadata forwarded to lifecycle and provisioning payloads. */
  metadata: JsonObjectContractSchema.optional(),
});

/**
 * Framework-level WorkerNode dispatch response.
 *
 * Returns an allocation acknowledgment after the provider has provisioned
 * a resource and the allocation reference has been persisted. Callers
 * that need the workflow result must await it through the Authority's
 * in-process waiter (`waitForOutcome`).
 */
export const WorkerNodeDispatchResponseSchema = z
  .object({
    executionAttemptId: z.string().min(1),
    allocationRef: ProviderAllocationRefSchema,
  })
  .strict();

/**
 * WorkerNode lifecycle bus schemas.
 *
 * All keys map to `worker-node.<key>` subjects on the bus. Each subject
 * represents a discrete phase in the node lifecycle so listeners can react
 * selectively without receiving unrelated payloads.
 *
 * Lifecycle states in order:
 * - `lifecycle.provisioning` — dispatch has selected a provider; node allocation is in progress
 * - `lifecycle.booting`      — environment is initialising (importing packages, connecting to bus)
 * - `lifecycle.ready`        — node is connected and ready to accept work
 * - `lifecycle.busy`         — node has started executing the workflow
 * - `lifecycle.completed`    — execution finished successfully
 * - `lifecycle.failed`       — execution terminated with an error
 * - `lifecycle.terminated`   — node environment has been torn down
 * - `lifecycle.paused`       — node parked at a gate and exited for later resume
 *
 * Control subjects:
 * - `control.attempt-ready`  — worker reports readiness for its attempt
 * - `control.outcome.submit` — worker submits an execution outcome for durable ACK
 * - `control.bootstrap.claim`— worker claims execution-scoped bus credentials
 */
export const WorkerNodeSchemas = {
  /**
   * Dispatch a workflow execution to a WorkerNode dispatcher.
   *
   * Subject: `worker-node.dispatch`
   * Type: Request (RPC)
   */
  dispatch: {
    request: WorkerNodeDispatchRequestSchema,
    response: WorkerNodeDispatchResponseSchema,
  },

  /**
   * Worker reports that it has booted, connected to the bus, and is ready
   * to execute the workflow for its assigned attempt.
   *
   * The Authority and lifecycle emitters consume this to transition the
   * attempt into the active execution phase.
   *
   * Subject: `worker-node.control.attempt-ready`
   * Type: Event
   */
  'control.attempt-ready': z
    .object({
      /** Authority-created attempt identifier. */
      executionAttemptId: z.string().min(1),
      /** Workflow execution identifier owned by this worker. */
      executionId: z.string().min(1),
      /** Adapter identifiers loaded inside the worker before readiness. */
      adapters: z.array(z.string().min(1)).default([]),
    })
    .strict(),

  /**
   * Worker submits a terminal workflow outcome for durable acknowledgement.
   *
   * The Authority validates the attempt, commits the outcome through the
   * injected repository, and returns an ACK decision. Workers must not
   * exit until they receive the ACK.
   *
   * Subject: `worker-node.control.outcome.submit`
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
   * Worker node claims its execution-scoped bus credentials during bootstrap.
   *
   * The node authenticates its WebSocket connection as a bootstrap peer, then
   * presents its execution/attempt identity. The server validates that trusted
   * transport identity and the durable allocation before exchanging it for an
   * execution-scoped `busAuthSecret` used for subsequent communication.
   *
   * Subject: `worker-node.control.bootstrap.claim`
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
        /** WebSocket URL of the bus server the node should connect to. */
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
   * Dispatch has selected a provider; node allocation is in progress.
   *
   * Subject: `worker-node.lifecycle.provisioning`
   * Type: Event
   */
  'lifecycle.provisioning': WorkerNodeLifecycleBaseSchema,

  /**
   * Environment is initialising (importing packages, connecting to bus).
   *
   * Subject: `worker-node.lifecycle.booting`
   * Type: Event
   */
  'lifecycle.booting': WorkerNodeLifecycleBaseSchema,

  /**
   * Node is connected and ready to accept work.
   *
   * Subject: `worker-node.lifecycle.ready`
   * Type: Event
   */
  'lifecycle.ready': WorkerNodeLifecycleBaseSchema.extend({
    /** Adapter identifiers that have been loaded and registered inside this node. */
    adapters: z.array(z.string().min(1)).default([]),
  }),

  /**
   * Node has started executing the workflow.
   *
   * Subject: `worker-node.lifecycle.busy`
   * Type: Event
   */
  'lifecycle.busy': WorkerNodeLifecycleBaseSchema,

  /**
   * Execution finished successfully.
   *
   * Subject: `worker-node.lifecycle.completed`
   * Type: Event
   */
  'lifecycle.completed': WorkerNodeLifecycleBaseSchema,

  /**
   * Execution terminated with an error.
   *
   * Subject: `worker-node.lifecycle.failed`
   * Type: Event
   */
  'lifecycle.failed': WorkerNodeLifecycleBaseSchema.extend({
    /** Human-readable error message describing the failure. */
    error: z.string().min(1),
  }),

  /**
   * Node environment has been torn down.
   *
   * Subject: `worker-node.lifecycle.terminated`
   * Type: Event
   */
  'lifecycle.terminated': WorkerNodeLifecycleBaseSchema.extend({
    /** Optional reason for termination (e.g. `'cancelled'`, `'timeout'`). */
    reason: z.string().optional(),
  }),

  /**
   * Node has suspended at a gate and the worker has exited.
   *
   * Emitted by providers using `exit-and-redispatch` or `exit-and-resume`
   * suspension strategies before the environment tears down. In-process
   * providers that block at the gate do not emit this event.
   *
   * Subject: `worker-node.lifecycle.paused`
   * Type: Event
   */
  'lifecycle.paused': WorkerNodeLifecycleBaseSchema.extend({
    /** Node ID of the gate at which execution paused. */
    pausedAtGateId: z.string().min(1),
    /** Frame ID of the suspended gate instance. */
    pausedAtFrameId: z.string().min(1),
  }),
} satisfies SchemaRecord;

/** Bootstrap coordinates presented by a remote worker. */
export type WorkerBootstrapClaimRequest = z.infer<(typeof WorkerNodeSchemas)['control.bootstrap.claim']['request']>;

/** Execution-scoped credentials issued after a successful bootstrap claim. */
export type WorkerBootstrapClaimResponse = z.infer<(typeof WorkerNodeSchemas)['control.bootstrap.claim']['response']>;
