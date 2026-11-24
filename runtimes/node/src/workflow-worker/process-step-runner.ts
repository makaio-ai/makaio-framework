import {
  WorkflowErrorCode,
  type IStepRunner,
  type StepRunConfig,
  type StepRunResult,
  type StepRunErrorCode,
  type WorkflowResolvedRole,
} from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { isValidLaunchTimeoutMs, type Launcher } from '@makaio/subprocess';
import { resolveAgentStepConfig } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { abortableWait } from '@makaio/utils';
import { runCheckoutCodeStep, type CheckoutCodeStepInvocation } from './checkout-code-step.js';
import {
  runAgentStepProcess,
  runCodeStepProcess,
  type CodeStepProcessResult,
  type LocalCodeStepInvocation,
} from './code-step-process.js';
import type { CheckoutWorkflowSource } from './checkout-workflow-reader.js';
import { openLocalModelAddress, type ModelCredentialSource } from './agent-step/model-mediator.js';
import { createHttpWorkerModelPort } from './agent-step/http-model-port.js';
import {
  prepareAgentModelRequest,
  AgentStepProcessFailureSchema,
  type AgentStepProcessInput,
  type AgentStepProcessFailure,
} from './agent-step/protocol.js';

import { STEP_EXECUTION_FAILED } from './step-interface-schemas.js';

type ProcessCommand = Pick<LocalCodeStepInvocation, 'command' | 'args'>;

/** Worker-owned inputs used to bind one process runner. */
export type ProcessStepCheckoutOptions =
  | {
      readonly checkout: Pick<CheckoutCodeStepInvocation, 'binding' | 'preparedSource'>;
      readonly onRequestRefused: (
        executionId: string,
        stepId: string,
        subject: string,
        reason: 'request-not-granted',
      ) => void | Promise<void>;
    }
  | { readonly checkout?: undefined; readonly onRequestRefused?: never };

/** Launch, role and model configuration for a worker run. */
export type ProcessStepRunnerOptions = ProcessStepCheckoutOptions & {
  readonly launcher: Launcher;
  readonly call: CallContext;
  readonly workspace: string;
  readonly codeCommand: ProcessCommand;
  readonly agentCommand: ProcessCommand;
  readonly timeoutMs: number;
  readonly resolveRole: (
    call: CallContext,
    role: string,
    signal: AbortSignal,
  ) => Promise<WorkflowResolvedRole | undefined>;
  readonly model?: {
    readonly credentialSource: ModelCredentialSource;
    readonly target: { readonly name: string; readonly url: URL };
    readonly adapterName: string;
    readonly ownerInstanceId: string;
  };
};

const agentFailureCodes = {
  'request-invalid': 'requestInvalid',
  'request-too-large': 'requestTooLarge',
  'model-not-in-session': 'modelNotInSession',
  'upstream-failed': 'upstreamFailed',
  'reply-invalid': 'replyInvalid',
  'streaming-unsupported': 'streamingUnsupported',
  'model-unreachable': 'modelUnreachable',
  'request-timed-out': 'requestTimedOut',
  environmentMissing: 'environmentMissing',
  'agent-start-refused': 'agentStartRefused',
  'agent-turn-failed': 'agentTurnFailed',
  'process-failed': 'processFailed',
  'output-invalid': 'invalidOutput',
  'prompt-too-large': 'promptTooLarge',
} satisfies Record<AgentStepProcessFailure, StepRunErrorCode>;

const checkoutFailureCodes = new Map<string, StepRunErrorCode>([
  [WorkflowErrorCode.SOURCE_MISMATCH, 'sourceMismatch'],
  [WorkflowErrorCode.NOT_EXECUTABLE, 'notExecutable'],
  [WorkflowErrorCode.HANDLER_UNAVAILABLE, 'handlerUnavailable'],
  [WorkflowErrorCode.LOOP_CHECK_MULTIPLE, 'loopCheckMultiple'],
  [STEP_EXECUTION_FAILED, 'stepExecutionFailed'],
]);

/**
 * Convert a process outcome to the workflow step contract.
 * @param process - Output and observed process termination.
 * @param requestDeadlineExpired - Whether the shared step deadline triggered the request signal.
 * @returns Workflow outcome with a bounded diagnostic.
 */
function toStepResult(process: CodeStepProcessResult, requestDeadlineExpired = false): StepRunResult {
  if (process.kind === 'reported') {
    const { error, ...result } = process.result;
    if (result.status !== 'failed') return result;
    const agent = AgentStepProcessFailureSchema.safeParse(error);
    const code = agent.success ? agentFailureCodes[agent.data] : checkoutFailureCodes.get(error ?? '');
    return { ...result, error: code ?? 'processFailed' };
  }
  const telemetry = { duration: 0 };
  if (
    process.kind === 'timed-out' ||
    (process.kind === 'cancelled' && requestDeadlineExpired && process.process.cancellationSource === 'request')
  ) {
    return { status: 'failed', error: 'timeLimit', telemetry };
  }
  if (process.kind === 'cancelled') return { status: 'cancelled', telemetry };
  if (process.kind === 'process-failed' && process.reason === 'refusal-observer-failed') {
    return { status: 'failed', error: 'requestRefusalObserverFailed', telemetry };
  }
  const error =
    process.kind === 'process-failed' && process.reason === 'invalid-output' ? 'invalidOutput' : 'processFailed';
  return { status: 'failed', error, telemetry };
}

/**
 * Check the role against the isolated adapter's capability envelope before acquiring authority.
 * @param role - Role selected by the workflow authority.
 * @param expectedAdapter - Adapter bound by the worker.
 * @returns Whether the selected role is implemented by this process runner.
 */
function supportsResolvedRole(role: WorkflowResolvedRole, expectedAdapter: string): boolean {
  const {
    adapterName,
    model: _model,
    systemPrompt: _systemPrompt,
    tools,
    contextMode,
    completion,
    ...overrides
  } = role;
  // The worker uses one configured target. Any additional role overrides need an explicit binding.
  return (
    adapterName === expectedAdapter &&
    (tools?.length ?? 0) === 0 &&
    contextMode !== 'fork' &&
    completion !== 'tool' &&
    Object.values(overrides).every((value) => value === undefined)
  );
}

/**
 * Resolve the role and run one isolated structured turn.
 * @param options - Model, adapter and ownership declared by the worker.
 * @param config - Resolved workflow invocation.
 * @param launch - Invocation for the trusted agent step entry.
 * @param workflowSignal - Cancellation from the workflow owner.
 * @returns Terminal agent step result.
 */
async function runAgentStep(
  options: ProcessStepRunnerOptions,
  config: Extract<StepRunConfig, { stepType: 'agent-step' }>,
  launch: Omit<LocalCodeStepInvocation, 'env'>,
  workflowSignal: AbortSignal,
): Promise<StepRunResult> {
  const fail = (error: StepRunErrorCode): StepRunResult => ({ status: 'failed', error, telemetry: { duration: 0 } });
  const cancelled: StepRunResult = { status: 'cancelled', telemetry: { duration: 0 } };
  if (workflowSignal.aborted) return cancelled;
  const model = options.model;
  // The host must grant model.use for this target. Worker bootstrap authorization only connects the bus.
  if (model === undefined) return fail('environmentMissing');
  if (!isValidLaunchTimeoutMs(launch.timeoutMs)) return fail('requestInvalid');
  const deadline = performance.now() + launch.timeoutMs;
  const timeout = AbortSignal.timeout(launch.timeoutMs);
  const signal = AbortSignal.any([workflowSignal, timeout]);
  const remainingMs = (): number => Math.max(0, Math.ceil(deadline - performance.now()));
  const interrupted = (): StepRunResult =>
    workflowSignal.aborted && signal.reason === workflowSignal.reason ? cancelled : fail('timeLimit');
  const resolveRole = async (): Promise<WorkflowResolvedRole | undefined> => {
    signal.throwIfAborted();
    return options.resolveRole(options.call, config.stepDefinition.role, signal);
  };
  const resolvedRole = await abortableWait(Promise.resolve().then(resolveRole), signal).catch((error: unknown) => {
    if (signal.aborted) return undefined;
    throw error;
  });
  if (signal.aborted || remainingMs() === 0) return interrupted();
  if (resolvedRole === undefined) return fail('unknownRole');
  const role = resolveAgentStepConfig(config.stepDefinition, resolvedRole);
  if (!supportsResolvedRole(role, model.adapterName)) {
    return fail('agentCapabilitiesUnsupported');
  }
  const { outputSchema } = config.stepDefinition;
  if (outputSchema === undefined) return fail('invalidOutput');
  if (!role.model) return fail('environmentMissing');
  const input: AgentStepProcessInput = {
    adapterId: model.adapterName,
    ownerInstanceId: model.ownerInstanceId,
    model: role.model,
    initialMessage: role.systemPrompt ? `${role.systemPrompt}\n\n${config.resolvedPrompt}` : config.resolvedPrompt,
    responseSchema: { schema: outputSchema },
  };
  const request = prepareAgentModelRequest(input.model, input.initialMessage, input.responseSchema);
  if (request.kind === 'too-large') return fail('promptTooLarge');
  if (request.kind === 'invalid') return fail('agentStartRefused');
  const requestTimeoutMs = remainingMs();
  if (signal.aborted || requestTimeoutMs === 0) return interrupted();
  const lease = await openLocalModelAddress({
    call: options.call,
    model: createHttpWorkerModelPort(role.model, model.target),
    credentialSource: model.credentialSource,
    target: model.target.name,
    signal,
    requestTimeoutMs,
  }).catch((error: unknown) => {
    if (signal.aborted) return undefined;
    throw error;
  });
  if (lease === undefined) return interrupted();
  try {
    const timeoutMs = remainingMs();
    if (signal.aborted || timeoutMs === 0) return interrupted();
    const process = await runAgentStepProcess(options.launcher, { ...launch, timeoutMs, signal }, input, lease.address);
    return toStepResult(process, timeout.aborted && signal.reason === timeout.reason);
  } finally {
    await lease.close();
  }
}

/**
 * Bind code and agent steps exclusively to the worker's process launcher.
 * @param options - Worker-local source evidence, commands and model policy.
 * @param registeredSource - Source staged by the local registered-workflow composition.
 * @returns The step runner to supply to the worker orchestrator.
 */
export function createProcessStepRunner(
  options: ProcessStepRunnerOptions,
  registeredSource?: CheckoutWorkflowSource,
): IStepRunner {
  let nextExecution = 0;
  return {
    async run(config, signal) {
      const common = {
        owner: { kind: 'step' as const, stepId: config.stepId, execution: ++nextExecution },
        signal,
      };
      if (config.stepType === 'agent-step') {
        const timeoutMs = config.stepDefinition.timeoutMs ?? options.timeoutMs;
        return runAgentStep(options, config, { ...common, ...options.agentCommand, timeoutMs }, signal);
      }
      const { checkout, onRequestRefused } = options;
      const launch = {
        ...common,
        ...options.codeCommand,
        timeoutMs: config.stepDefinition.timeoutMs ?? options.timeoutMs,
      };
      const step = { step: config.stepId, input: config.data, workspace: options.workspace };
      if (registeredSource !== undefined) {
        return toStepResult(
          await runCodeStepProcess(
            options.launcher,
            { ...launch, env: {} },
            {
              input: { ...step, source: registeredSource },
              onRequestRefused: () => console.warn('[workflow-worker] Registered code step request refused'),
            },
          ),
        );
      }
      if (checkout === undefined) {
        return { status: 'failed', error: 'sourceNotPrepared', telemetry: { duration: 0 } };
      }
      return toStepResult(
        await runCheckoutCodeStep(options.launcher, {
          ...launch,
          ...checkout,
          step,
          onRequestRefused: (subject, reason) =>
            onRequestRefused(config.data.executionId, config.stepId, subject, reason),
        }),
      );
    },
  };
}
