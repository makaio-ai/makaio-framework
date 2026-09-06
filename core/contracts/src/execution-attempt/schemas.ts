import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Kind discriminator for an operation admitted against an ExecutionAttempt.
 *
 * A typed discriminator rather than an opaque owner-supplied string: the Worker
 * Runtime is framework code and must know how to execute every member.
 *
 * - `runtime-probe` — the bounded no-op that proves the runtime endpoint accepts
 *   a fenced instruction; never projected to the pool.
 * - `workflow-run` — the durable owner's workflow execution.
 */
export const ExecutionAttemptOperationKindSchema = z.enum(['runtime-probe', 'workflow-run']);

/** Kind of an operation admitted against an ExecutionAttempt. */
export type ExecutionAttemptOperationKind = z.infer<typeof ExecutionAttemptOperationKindSchema>;

/**
 * Kinds an operation may have when its admission is announced.
 *
 * The full vocabulary minus `runtime-probe`: the probe is admitted by runtime
 * registration alone and is never announced, so `operation.admitted` carries
 * this narrower schema and a producer cannot announce a probe by mistake. A
 * later kind added to {@link ExecutionAttemptOperationKindSchema} joins this
 * vocabulary without a second edit.
 */
export const ExecutionAttemptAnnouncedOperationKindSchema = ExecutionAttemptOperationKindSchema.exclude([
  'runtime-probe',
]);

/** Kind of an operation announced through `operation.admitted`. */
export type ExecutionAttemptAnnouncedOperationKind = z.infer<typeof ExecutionAttemptAnnouncedOperationKindSchema>;

/**
 * Authority → runtime delivery of one admitted operation.
 *
 * Exported separately from {@link ExecutionAttemptSchemas} so the Worker Runtime
 * client can type its own responder without indexing the schema record.
 */
export const ExecutionAttemptOperationDeliverySchema = z
  .object({
    /** Authority-created attempt identifier the operation belongs to. */
    executionAttemptId: z.string().min(1),
    /**
     * Runtime incarnation the delivery is addressed to.
     *
     * The incarnation that registered and now owns the attempt's generation.
     * Together with `executionAttemptId` it is the runtime's subscription
     * filter, so a stale incarnation of the same attempt that is still
     * connected never sees a delivery meant for its successor.
     */
    runtimeIncarnationId: z.string().min(1),
    /** Authority-created identifier of the admitted operation. */
    operationId: z.string().min(1),
    /** Kind of operation the runtime must execute. */
    operationKind: ExecutionAttemptOperationKindSchema,
    /** Runtime generation the delivery is fenced against. */
    runtimeGeneration: z.number().int().positive(),
  })
  .strict();

/**
 * Runtime → authority receipt for one delivered operation.
 *
 * Exported separately from {@link ExecutionAttemptSchemas} so the Worker Runtime
 * client can type its own responder without indexing the schema record.
 */
export const ExecutionAttemptOperationReceiptSchema = z
  .object({
    /** Outcome of the delivery as seen by the addressed runtime. */
    receipt: z.enum(['completed', 'duplicate', 'refused']),
    /**
     * Why the runtime refused; present only when `receipt` is `refused`.
     *
     * `stale-generation`: the delivery is fenced against a generation other
     * than the one this runtime was accepted with. `unknown-kind`: the runtime
     * installed no executor for the delivered kind. There is no "wrong
     * attempt" reason — the subscription filter is that fence, and a delivery
     * for another attempt or incarnation never reaches the runtime.
     */
    refusalReason: z.enum(['stale-generation', 'unknown-kind']).optional(),
  })
  .strict();

/**
 * ExecutionAttempt runtime-registration and operation-admission bus schemas.
 *
 * All keys map to `execution-attempt.<key>` subjects on the bus. The namespace is
 * static: five subjects, no per-attempt namespace factory. Per-attempt addressing
 * is done with `bus.withFilter({ executionAttemptId })` on the payload (and, for
 * deliveries, the addressed `runtimeIncarnationId`), not by minting a namespace
 * per attempt.
 *
 * Subjects by category:
 * - `runtime.register`, `operation.admit` — authority RPC gates. Exactly one
 *   handler site outside tests, which refuses on peer mismatch.
 * - `runtime.ready`, `operation.admitted`, `operation.deliver` — per-attempt
 *   subjects. Every interested component installs its own listener scoped to its
 *   own attempt and returns on mismatch; another attempt's message is not an error.
 *
 * No payload carries `executionId`, and none carries `controlRevision`.
 */
/** Refusal vocabulary of `execution-attempt.runtime.register`. */
export const ExecutionAttemptRuntimeRegisterRefusalReasonSchema = z.enum([
  'not-found',
  'resolved',
  'fenced',
  'not-allocated',
  'operation-active',
  'probe-failed',
]);

/**
 * A registration decision that hands out a fence.
 *
 * `ready` and `duplicate` both carry the positive generation the runtime must
 * fence all later traffic with; only a refusal carries generation zero, so a
 * runtime can never read "registered at generation zero" out of a decision.
 * @param decision - The accepting decision literal.
 * @returns The strict response shape for that decision.
 */
const registeredDecision = <TDecision extends 'ready' | 'duplicate'>(decision: TDecision) =>
  z
    .object({
      /** Registration decision taken by the authority. */
      decision: z.literal(decision),
      /** Generation the registered runtime must fence all later traffic with. */
      runtimeGeneration: z.number().int().positive(),
    })
    .strict();

export const ExecutionAttemptSchemas = {
  /**
   * The Worker Runtime reports that its incarnation is alive and asks to be
   * registered as the endpoint of its ExecutionAttempt.
   *
   * Emitter: Worker Runtime (headless worker, Piscina thread).
   * Handler: exactly one authority gate (`runtime-registration.ts`), which refuses
   * on peer mismatch.
   * Effect: allocates the runtime generation, proves the endpoint by admitting and
   * delivering the bounded runtime probe, persists readiness, publishes
   * `execution-attempt.runtime.ready`, and replies with the decision.
   *
   * Subject: `execution-attempt.runtime.register`
   * Type: Request (RPC) — report → decision
   */
  'runtime.register': {
    request: z
      .object({
        /** Authority-created attempt identifier the runtime claims. */
        executionAttemptId: z.string().min(1),
        /** Identifier of this concrete runtime incarnation, unique per boot. */
        runtimeIncarnationId: z.string().min(1),
      })
      .strict(),
    response: z.discriminatedUnion('decision', [
      registeredDecision('ready'),
      registeredDecision('duplicate'),
      z
        .object({
          /** Registration decision taken by the authority. */
          decision: z.literal('refused'),
          /** A refusal hands out no fence: the generation is always zero. */
          runtimeGeneration: z.literal(0),
          /** Why registration was refused. */
          refusalReason: ExecutionAttemptRuntimeRegisterRefusalReasonSchema,
        })
        .strict(),
    ]),
  },

  /**
   * The authority announces that an ExecutionAttempt has a proven runtime endpoint.
   *
   * Emitter: attempt authority (`runtime-registration.ts`).
   * Handlers: per-instance listeners filtered on their own `executionAttemptId` —
   * the worker pool observer and the Fly machine tracker. A filter miss returns; it
   * is not an error.
   * Effect: the pool projects `worker.lifecycle.ready`; the provider settles its
   * boot supervision.
   *
   * Subject: `execution-attempt.runtime.ready`
   * Type: Event
   */
  'runtime.ready': z
    .object({
      /** Authority-created attempt identifier whose runtime is proven. */
      executionAttemptId: z.string().min(1),
      /** Generation allocated to the registered runtime. */
      runtimeGeneration: z.number().int().positive(),
      /** ISO timestamp at which the authority accepted the registration. */
      acceptedAt: z.string().min(1),
    })
    .strict(),

  /**
   * A caller asks the authority to admit one operation through the attempt's
   * start gate.
   *
   * Emitter: Worker Runtime in this slice; the durable owner in later slices.
   * Handler: exactly one authority gate (`operation-admission.ts`), which refuses
   * on peer mismatch.
   * Effect: admits at most one operation at a time, keyed by `admissionKey` so a
   * retry is answered `duplicate` rather than admitted twice, and replies with the
   * decision.
   *
   * Subject: `execution-attempt.operation.admit`
   * Type: Request (RPC) — command → decision
   */
  'operation.admit': {
    request: z
      .object({
        /** Authority-created attempt identifier the operation runs under. */
        executionAttemptId: z.string().min(1),
        /** Kind of operation being admitted. */
        operationKind: ExecutionAttemptOperationKindSchema,
        /** Caller-chosen idempotency key for this admission. */
        admissionKey: z.string().min(1),
        /** Runtime generation the caller fences the admission against. */
        runtimeGeneration: z.number().int().positive(),
      })
      .strict(),
    response: z
      .object({
        /** Admission decision taken by the authority. */
        decision: z.enum(['admitted', 'duplicate', 'refused']),
        /** Identifier of the admitted operation; absent when `decision` is `refused`. */
        operationId: z.string().min(1).optional(),
        /** Why admission was refused; present only when `decision` is `refused`. */
        refusalReason: z
          .enum([
            'not-found',
            'resolved',
            'fenced',
            'not-allocated',
            'operation-active',
            'gate-closed',
            'not-ready',
            'stale-generation',
          ])
          .optional(),
      })
      .strict(),
  },

  /**
   * The authority announces that a non-probe operation passed the start gate.
   *
   * Emitter: attempt authority (`operation-admission.ts`), for non-probe kinds only —
   * the bounded runtime probe never reaches the pool.
   * Handler: per-instance listener filtered on its own `executionAttemptId` — the
   * worker pool observer. A filter miss returns; it is not an error.
   * Effect: the pool projects `worker.lifecycle.busy`.
   *
   * Subject: `execution-attempt.operation.admitted`
   * Type: Event
   */
  'operation.admitted': z
    .object({
      /** Authority-created attempt identifier the operation runs under. */
      executionAttemptId: z.string().min(1),
      /** Authority-created identifier of the admitted operation. */
      operationId: z.string().min(1),
      /** Kind of operation that was admitted; the probe is excluded by schema. */
      operationKind: ExecutionAttemptAnnouncedOperationKindSchema,
      /** Generation the admitted operation is fenced against. */
      runtimeGeneration: z.number().int().positive(),
      /** ISO timestamp at which the authority admitted the operation. */
      admittedAt: z.string().min(1),
    })
    .strict(),

  /**
   * The authority hands one admitted operation to the runtime that owns the attempt.
   *
   * This is the only subject in the namespace on which the authority is the
   * requester and the runtime the responder.
   *
   * Emitter: attempt authority (`runtime-registration.ts`).
   * Handlers: every live Worker Runtime, each subscribing through
   * `bus.withFilter({ executionAttemptId, runtimeIncarnationId })` rather than
   * owning the subject globally. A filter miss returns undefined and
   * auto-advances the dispatch chain to the next responder, so only the
   * addressed incarnation answers — never a stale one of the same attempt.
   * Effect: the addressed runtime executes the delivered operation and returns its
   * receipt.
   *
   * Subject: `execution-attempt.operation.deliver`
   * Type: Request (RPC) — delivery → receipt
   */
  'operation.deliver': {
    request: ExecutionAttemptOperationDeliverySchema,
    response: ExecutionAttemptOperationReceiptSchema,
  },
} as const satisfies SchemaRecord;

/** Runtime → authority registration report. */
export type ExecutionAttemptRuntimeRegisterRequest = z.infer<
  (typeof ExecutionAttemptSchemas)['runtime.register']['request']
>;

/** Authority → runtime registration decision. */
export type ExecutionAttemptRuntimeRegisterResponse = z.infer<
  (typeof ExecutionAttemptSchemas)['runtime.register']['response']
>;

/** Decision vocabulary of `execution-attempt.runtime.register`. */
export type ExecutionAttemptRuntimeRegisterDecision = ExecutionAttemptRuntimeRegisterResponse['decision'];

/** Refusal vocabulary of `execution-attempt.runtime.register`. */
export type ExecutionAttemptRuntimeRegisterRefusalReason = z.infer<
  typeof ExecutionAttemptRuntimeRegisterRefusalReasonSchema
>;

/** Payload of the `execution-attempt.runtime.ready` event. */
export type ExecutionAttemptRuntimeReadyEvent = z.infer<(typeof ExecutionAttemptSchemas)['runtime.ready']>;

/** Caller → authority admission command. */
export type ExecutionAttemptOperationAdmitRequest = z.infer<
  (typeof ExecutionAttemptSchemas)['operation.admit']['request']
>;

/** Authority → caller admission decision. */
export type ExecutionAttemptOperationAdmitResponse = z.infer<
  (typeof ExecutionAttemptSchemas)['operation.admit']['response']
>;

/** Decision vocabulary of `execution-attempt.operation.admit`. */
export type ExecutionAttemptOperationAdmitDecision = ExecutionAttemptOperationAdmitResponse['decision'];

/** Refusal vocabulary of `execution-attempt.operation.admit`. */
export type ExecutionAttemptOperationAdmitRefusalReason = NonNullable<
  ExecutionAttemptOperationAdmitResponse['refusalReason']
>;

/** Payload of the `execution-attempt.operation.admitted` event. */
export type ExecutionAttemptOperationAdmittedEvent = z.infer<(typeof ExecutionAttemptSchemas)['operation.admitted']>;

/** Authority → runtime delivery of one admitted operation. */
export type ExecutionAttemptOperationDelivery = z.infer<typeof ExecutionAttemptOperationDeliverySchema>;

/** Runtime → authority receipt for one delivered operation. */
export type ExecutionAttemptOperationReceipt = z.infer<typeof ExecutionAttemptOperationReceiptSchema>;

/** Receipt vocabulary of `execution-attempt.operation.deliver`. */
export type ExecutionAttemptOperationReceiptCode = ExecutionAttemptOperationReceipt['receipt'];

/** Refusal vocabulary of `execution-attempt.operation.deliver`. */
export type ExecutionAttemptOperationDeliveryRefusalReason = NonNullable<
  ExecutionAttemptOperationReceipt['refusalReason']
>;
