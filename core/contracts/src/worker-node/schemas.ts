import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import { WorkerNodeRequirementsSchema } from '../capabilities/worker-node/index.js';
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
  /** Unique identifier for this node instance within an execution. */
  nodeId: z.string().min(1),
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
  /** Full workflow worker configuration. */
  config: WorkflowWorkerConfigSchema,
  /**
   * Optional concrete manifest already resolved by the caller.
   *
   * Omit this field when the dispatch implementation should resolve the
   * applicable manifest itself. Callers that need to force an explicit empty
   * manifest should pass a manifest with `packages: []`.
   */
  manifest: WorkerContributionManifestSchema.optional(),
  /** Optional resource requirements used by the dispatch implementation. */
  requirements: WorkerNodeRequirementsSchema.optional(),
  /** Opaque caller metadata forwarded to lifecycle and provisioning payloads. */
  metadata: JsonObjectContractSchema.optional(),
});

/**
 * Framework-level WorkerNode dispatch response.
 */
export const WorkerNodeDispatchResponseSchema = WorkflowRunResultSchema;

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
   * Worker runtime has connected to the host bus and is ready to receive
   * control messages. Providers consume this as an internal readiness signal;
   * WorkerPoolService remains responsible for public lifecycle emission.
   *
   * Subject: `worker-node.control.ready`
   * Type: Event
   */
  'control.ready': z.object({
    /** Node identifier assigned by the provider and passed to the worker bootstrap. */
    nodeId: z.string().min(1),
    /** Workflow execution identifier owned by this worker. */
    executionId: z.string().min(1),
    /** Adapter identifiers loaded inside the worker before readiness. */
    adapters: z.array(z.string().min(1)).default([]),
  }),

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
} satisfies SchemaRecord;
