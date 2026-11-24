import { z } from 'zod';
import { JsonValueSchema } from '../shared/json-value.js';

/** Serializable run data available to a Code Step at any execution site. */
export const CodeStepDataSchema = z.strictObject({
  executionId: z.string().min(1),
  workflowId: z.string().min(1),
  inputs: JsonValueSchema,
  config: z.record(z.string(), JsonValueSchema),
  previousSteps: z.record(
    z.string(),
    z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('completed'), output: JsonValueSchema }),
      z.strictObject({ status: z.literal('skipped') }),
    ]),
  ),
  item: JsonValueSchema.optional(),
  index: z.number().int().nonnegative().optional(),
  previous: JsonValueSchema.optional(),
});

/** Serializable Code Step data, before the runtime supplies its capabilities. */
export type CodeStepData = z.infer<typeof CodeStepDataSchema>;

/** A malformed invocation that fails validation before reaching the runtime capability. */
export const CODE_STEP_INVALID_REQUEST = 'makaio.step-invalid-request';

/** Refusal for a request that does not match its declared input. */
export const CODE_STEP_REQUEST_REJECTED = 'request-rejected';

/** Payload for a request made through the step's execution boundary. */
export const CodeStepRequestInputSchema = z.strictObject({
  subject: z.string().min(1),
  payload: JsonValueSchema,
});

/** Outcome of a Code Step request. */
export const CodeStepRequestResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), response: JsonValueSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['request-not-granted', CODE_STEP_REQUEST_REJECTED, 'request-failed']),
    detail: z.string().optional(),
  }),
]);

/** Request from an authored Code Step. */
export type CodeStepRequestInput = z.infer<typeof CodeStepRequestInputSchema>;

/** Response to an authored Code Step. */
export type CodeStepRequestResult = z.infer<typeof CodeStepRequestResultSchema>;

/** Process request whose environment, ownership and time limits are supplied by the runtime. */
export const CodeStepLaunchInputSchema = z.strictObject({
  program: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  stdin: z.enum(['none', 'pipe']),
});

/** Process input available to an authored Code Step. */
export type CodeStepLaunchInput = z.infer<typeof CodeStepLaunchInputSchema>;

/** A process start refused before returning a handle to the step. */
export const CodeStepLaunchRefusalSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    'site-unreachable',
    CODE_STEP_INVALID_REQUEST,
    'invalid-timeout',
    'invalid-output-limit',
    'command-not-found',
    'spawn-error',
    'unsupported-site',
    'invalid-owner',
    'owner-closed',
    'cwd-outside-workspace',
    'reserved-entry',
    'home-unavailable',
  ]),
});

/** Process handle available to a Code Step, independent of the execution site. */
export interface StepLaunchedProcess {
  /** Observed completion of the process. */
  readonly result: Promise<{
    readonly status:
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'timed-out'
      | 'output-limit'
      | 'spawn-failed'
      | 'stop-failed';
    readonly exitCode?: number;
  }>;
  /** Standard input when a pipe was requested. */
  readonly stdin?: WritableStream<Uint8Array>;
  /** Standard output when captured by the runtime. */
  readonly stdout?: ReadableStream<Uint8Array>;
  /** Standard error when captured by the runtime. */
  readonly stderr?: ReadableStream<Uint8Array>;
}

/** Decision returned by the Code Step's managed process capability. */
export type CodeStepLaunchResult =
  | { readonly ok: true; readonly handle: StepLaunchedProcess }
  | z.infer<typeof CodeStepLaunchRefusalSchema>;
