import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonObjectContractSchema } from '../shared/json-value.js';

/**
 * Base fields present on every WorkerNode lifecycle event.
 *
 * Pool identity is deliberately absent — pool assignment is product-owned and
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
    adapters: z.array(z.string()).default([]),
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
