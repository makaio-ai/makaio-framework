import { createBusNamespace, ExtensionNameSchema, type CallContext, type SchemaRecord } from '@makaio/core';
import { z } from 'zod';
import type { HostTransaction } from '../host-database/index.js';
import { JsonValueSchema, rejectingLossyJsonValues } from '../shared/index.js';
import type { JobRunId } from './identifiers.js';
import { WorkflowRunResultSchema } from './worker.js';

/** The engine derives the job run from the authenticated caller. */
export const OutcomeSubmitRequestSchema = z.strictObject({
  /**
   * Worker outcome whose identity the engine checks against the authenticated caller.
   * The shared artifact data parser can discard own `__proto__` keys during JSON validation.
   */
  result: WorkflowRunResultSchema,
});

/** Worker submission body. */
export type OutcomeSubmitRequest = z.infer<typeof OutcomeSubmitRequestSchema>;

/** Refusal codes reserved for the engine. */
export const CoreOutcomeRefusalCodeSchema = z.enum([
  /** The bound owner is unavailable; retry the same submission. */
  'owner-unavailable',
  /** The run is outside running; even an early submission is final. */
  'run-not-running',
  /** The run does not exist. */
  'run-unknown',
  /** The authenticated caller does not own the run. */
  'not-own-job-run',
  /** A different outcome has already been submitted. */
  'outcome-conflict',
  /** The submitted outcome exceeds the accepted size. */
  'outcome-too-large',
]);

/** Reasons emitted by the engine while handling an outcome submission. */
export type CoreOutcomeRefusalCode = z.infer<typeof CoreOutcomeRefusalCodeSchema>;

const OpaqueOutcomeDataSchema = rejectingLossyJsonValues(JsonValueSchema, {
  prototypeKey: 'Outcome data cannot carry a prototype key',
  nonPlainObject: 'Outcome data must use plain JSON objects',
  symbolKey: 'Outcome data cannot carry symbol keys',
  nonEnumerableKey: 'Outcome data cannot carry hidden properties',
  extraArrayKey: 'Outcome arrays cannot carry extra fields',
});

const RefusalBaseSchema = z.strictObject({
  decision: z.literal('refused'),
  /** Whether the same submission may be retried. */
  retryable: z.boolean(),
  /** Optional diagnostic data from the refusing handler. */
  detail: OpaqueOutcomeDataSchema.optional(),
});

/** First acceptance, replay of an acceptance, or a refusal with its origin. */
export const OutcomeSubmitResponseSchema = z.union([
  z.strictObject({
    decision: z.literal('accepted'),
    /** Answer persisted on first acceptance. */
    answer: OpaqueOutcomeDataSchema,
  }),
  z.strictObject({
    decision: z.literal('duplicate'),
    /** Previously persisted answer for the same submission. */
    answer: OpaqueOutcomeDataSchema,
  }),
  RefusalBaseSchema.extend({
    code: z.literal('owner-unavailable'),
    /** Retry with the same submission when the owner becomes available. */
    retryable: z.literal(true),
  }),
  RefusalBaseSchema.extend({
    code: CoreOutcomeRefusalCodeSchema.exclude(['owner-unavailable']),
    /** Other core refusals are final. */
    retryable: z.literal(false),
  }),
  RefusalBaseSchema.extend({
    /** An acceptance owner's code from outside the engine's reserved vocabulary. */
    code: z
      .string()
      .min(1)
      .refine((code) => !CoreOutcomeRefusalCodeSchema.safeParse(code).success),
    /** Extension that issued the refusal, attached by the engine. */
    owner: ExtensionNameSchema,
  }),
]);

type ParsedOutcomeResponse = z.infer<typeof OutcomeSubmitResponseSchema>;
type CoreRefusal = { decision: 'refused'; code: CoreOutcomeRefusalCode };

/**
 * Response from the outcome submission subject. Owner refusals use a string
 * code. TypeScript cannot exclude individual literals from string, so the
 * runtime schema rejects reserved engine codes on the owner branch.
 */
export type OutcomeSubmitResponse =
  | Exclude<ParsedOutcomeResponse, CoreRefusal>
  | (Extract<ParsedOutcomeResponse, CoreRefusal> & { readonly owner?: never });

/** Schema record for the job-run outcome subject. */
export const JobRunOutcomeSchemas = {
  'outcome.submit': { request: OutcomeSubmitRequestSchema, response: OutcomeSubmitResponseSchema },
} satisfies SchemaRecord;

/** Engine-owned namespace for worker outcome submission. Register it with the engine. */
export const JobRunOutcomeNamespace = createBusNamespace('makaio:job-runs', JobRunOutcomeSchemas);

/** A worker result or a terminal condition where no result was obtained. */
export const JobRunEndingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    /** The runtime supplied a terminal result. */
    kind: z.literal('result'),
    /** Worker result checked against the run identity during close.
     * The shared artifact data parser can discard own `__proto__` keys during JSON validation.
     */
    result: WorkflowRunResultSchema,
  }),
  z.strictObject({
    /** The acceptance owner closed without a worker result. */
    kind: z.literal('no-result'),
    /** Terminal disposition chosen by the acceptance owner. */
    outcome: z.enum(['lost', 'cancelled']),
    /** Reason for a close without a worker result. */
    cause: z.string().min(1),
  }),
]);

/** Terminal input to the close capability. */
export type JobRunEnding = z.infer<typeof JobRunEndingSchema>;

/** Errors surfaced by the transactional close capability. */
export const JobRunErrorCodeSchema = z.enum([
  /** The run does not exist. */
  'run-unknown',
  /** The run is not in a state this ending may close. */
  'run-not-running',
  /** The capability holder is not the recorded owner. */
  'not-acceptance-owner',
  /** The result names a different run. */
  'result-run-mismatch',
  /** The ending is incompatible with the current state. */
  'ending-invalid',
  /** The engine is present but not active. */
  'engine-not-active',
  /** The engine is unavailable on this host. */
  'engine-absent',
]);
/** Close capability error codes. */
export type JobRunErrorCode = z.infer<typeof JobRunErrorCodeSchema>;

/** Inputs owned by the acceptance owner for its transactional close. */
export interface CloseJobRunInput {
  /** Open host transaction owned by the acceptance handler. */
  readonly tx: HostTransaction;
  /** Run to close, checked against the result identity when ending.kind is 'result'. */
  readonly jobRunId: JobRunId;
  /** Terminal decision to persist. */
  readonly ending: JobRunEnding;
}

/** Transactional close exposed to the bound acceptance owner. */
export interface JobRunCapability {
  /**
   * Close the run and journal its ending in the given transaction.
   * @param call - Context of the accepted operation.
   * @param input - Acceptance owner's transaction and terminal decision.
   */
  close(call: CallContext, input: CloseJobRunInput): Promise<void>;
}
