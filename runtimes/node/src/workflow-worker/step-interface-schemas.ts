import {
  CodeStepDataSchema,
  CodeStepLaunchInputSchema,
  CodeStepLaunchRefusalSchema,
  CodeStepRequestInputSchema,
  CodeStepRequestResultSchema,
  WorkflowErrorCode,
  StepRunResultSchema,
} from '@makaio/contracts';
import { z } from 'zod';

const RequestIdSchema = z.union([z.string(), z.number()]);

/** First and only invocation message sent by the worker to the step. */
export const CheckoutCodeStepInputSchema = z.strictObject({
  source: z.strictObject({
    checkoutRoot: z.string().min(1),
    workflowPath: z.string().min(1),
    workflowId: z.string().min(1),
  }),
  step: z.string().min(1),
  workspace: z.string().min(1),
  input: CodeStepDataSchema,
});

/** Data-only checkout step input. */
export type CheckoutCodeStepInput = z.infer<typeof CheckoutCodeStepInputSchema>;

export const STEP_EXECUTION_FAILED = 'makaio.step-execution-failed';
export const STEP_METHOD_NOT_SUPPORTED = 'makaio.step-method-not-supported';
/** Stable failure codes that can cross the checked checkout channel. */
export const CheckoutCodeStepFailureSchema = z.enum([
  WorkflowErrorCode.SOURCE_MISMATCH,
  WorkflowErrorCode.NOT_EXECUTABLE,
  WorkflowErrorCode.HANDLER_UNAVAILABLE,
  WorkflowErrorCode.LOOP_CHECK_MULTIPLE,
  STEP_EXECUTION_FAILED,
]);

/** The step is identified by its channel. The worker supplies the launch policy. */
export const StepProcessLaunchRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: RequestIdSchema,
  method: z.literal('process.launch'),
  params: CodeStepLaunchInputSchema,
});

/** The current execution site declines nested process launches. */
export const StepProcessLaunchRefusalSchema = CodeStepLaunchRefusalSchema;

/** Request an extension subject through the worker using the step's granted authority. */
export const StepRequestCallRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: RequestIdSchema,
  method: z.literal('request.call'),
  params: CodeStepRequestInputSchema,
});

/** Result returned by the worker for an extension request. */
export const StepRequestCallResultSchema = CodeStepRequestResultSchema;

/** Child-supplied diagnostics are untrusted until classified by the worker. */
export const StepProcessResultSchema = StepRunResultSchema.omit({ detail: true }).extend({
  error: z.string().optional(),
});

export type StepProcessResult = z.infer<typeof StepProcessResultSchema>;
