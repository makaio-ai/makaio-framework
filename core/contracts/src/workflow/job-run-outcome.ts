import {
  createBusNamespace,
  ExtensionNameSchema,
  hostLocalRequest,
  journalSubject,
  MAKAIO_JOB_RUN_PARTY_KIND,
  type CallContext,
  type SchemaRecord,
} from '@makaio/core';
import { z } from 'zod';
import type { StartOrder } from '../capabilities/worker/ordered-dispatch.js';
import type { HostTransaction } from '../host-database/index.js';
import { JsonValueSchema, rejectingLossyJsonValues, type JsonValue } from '../shared/index.js';
import { JobRunIdSchema, type JobRunId } from './identifiers.js';

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
  /** The authenticated caller sent an invalid outcome payload. */
  'outcome-invalid',
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

const resultFields = {
  jobRunId: JobRunIdSchema,
  workflowId: z.string().min(1),
  submission: OpaqueOutcomeDataSchema.optional(),
};

/** Terminal result sent by an ordered worker. */
export const JobRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultFields, status: z.literal('completed') }),
  z.strictObject({ ...resultFields, status: z.literal('failed'), error: z.string() }),
  z.strictObject({ ...resultFields, status: z.literal('cancelled'), reason: z.string().optional() }),
]);

/** The complete result used when comparing a submission to the durable receipt. */
export type JobRunResult = z.infer<typeof JobRunResultSchema>;

/** The receiver checks `payload.result.jobRunId` against the authenticated caller. */
export const OutcomeSubmitRequestSchema = z.strictObject({ result: JobRunResultSchema });

/** Worker submission body. */
export type OutcomeSubmitRequest = z.infer<typeof OutcomeSubmitRequestSchema>;

const RefusalBaseSchema = z.strictObject({
  decision: z.literal('refused'),
  /** Whether the same submission may be retried. */
  retryable: z.boolean(),
  /** Optional diagnostic data from the refusing handler. */
  detail: OpaqueOutcomeDataSchema.optional(),
});

/**
 * First acceptance, authorized replay, or a refusal with its origin.
 * Replay checks the run proof before reading the receipt. After revocation,
 * replay returns `not-own-job-run`; the committed outcome and first answer remain stored.
 */
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
  'outcome.submit': journalSubject(
    hostLocalRequest({ request: OutcomeSubmitRequestSchema, response: OutcomeSubmitResponseSchema }),
    { suggestedFor: { send: [MAKAIO_JOB_RUN_PARTY_KIND] } },
  ),
} satisfies SchemaRecord;

/** Engine-owned namespace for worker outcome submission. Register it with the engine. */
export const JobRunOutcomeNamespace = createBusNamespace('makaio:job-runs', JobRunOutcomeSchemas);

/** A worker result or a terminal condition where no result was obtained. */
export const JobRunEndingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    /** The runtime supplied a terminal result. */
    kind: z.literal('result'),
    /** Worker result checked against the run identity during close. */
    result: JobRunResultSchema,
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
  /** The submitted result already has a committed receipt. */
  'outcome-already-stored',
  /** The engine is present but not active. */
  'engine-not-active',
  /** The engine is unavailable on this host. */
  'engine-absent',
]);
/** Close capability error codes. */
export type JobRunErrorCode = z.infer<typeof JobRunErrorCodeSchema>;

interface CloseJobRunTransaction {
  /** Open host transaction owned by the acceptance handler. */
  readonly tx: HostTransaction;
  /** Run to close, checked against the result identity when ending.kind is 'result'. */
  readonly jobRunId: JobRunId;
}

/** Inputs owned by the acceptance owner for its transactional close. */
export type CloseJobRunInput = CloseJobRunTransaction &
  (
    | {
        readonly ending: Extract<JobRunEnding, { kind: 'result' }>;
        /** First response to persist with the authenticated result. */
        readonly answer: JsonValue;
      }
    | { readonly ending: Extract<JobRunEnding, { kind: 'no-result' }>; readonly answer?: never }
  );

/** Transactional close exposed to the bound acceptance owner. */
export interface JobRunCapability {
  /**
   * Close the run and journal its ending in the given transaction.
   * @param call - Context of the accepted operation.
   * @param input - Acceptance owner's transaction and terminal decision.
   */
  close(call: CallContext, input: CloseJobRunInput): Promise<void>;
}

/** Owner disposition after processing an authenticated result. */
export type JobRunOwnerDecision =
  | { readonly decision: 'accepted' }
  | { readonly decision: 'refused'; readonly code: string; readonly retryable: boolean; readonly detail?: JsonValue };

/** The immutable booking and validated worker result presented to the owner. */
export interface JobRunAcceptance {
  /** Original authenticated call, preserved by the host. */
  readonly call: CallContext;
  /** Booking verified against the authenticated run. */
  readonly order: StartOrder;
  /** Validated result. The host binds its close capability to this value and call. */
  readonly result: Readonly<JobRunResult>;
  /** Close authority scoped to this invocation. */
  readonly jobRuns: JobRunCapability;
  /** Lifetime of the owner generation. Delivery timeouts are independent. */
  readonly signal: AbortSignal;
}

/** Handler bound to one extension activation. */
export type JobRunOutcomeHandler = (submission: JobRunAcceptance) => Promise<JobRunOwnerDecision>;
