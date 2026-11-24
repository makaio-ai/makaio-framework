import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRegisteredRequestSubject, type IMakaioBus } from '@makaio/bus-core';
import {
  ACCESS_DENIED_ERROR_CODE,
  CODE_STEP_INVALID_REQUEST,
  CODE_STEP_REQUEST_REJECTED,
  CodeStepLaunchInputSchema,
  CodeStepRequestInputSchema,
  JsonValueSchema,
  type StepContext,
} from '@makaio/contracts';
import { isRequestSchema, type CallContext } from '@makaio/core';
import { createLocalLauncher } from '@makaio/subprocess';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

const STEP_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * Send only registered request subjects through the original run authority.
 * @param bus - Bus owned by the local run.
 * @param call - Context that started this run.
 * @param signal - Cancellation signal for this step occurrence.
 * @returns The author-facing request capability.
 */
function bindRequest(bus: IMakaioBus, call: CallContext, signal: AbortSignal): StepContext['request'] {
  return async (input) => {
    const request = CodeStepRequestInputSchema.safeParse(input);
    if (!request.success) return { ok: false, code: CODE_STEP_REQUEST_REJECTED };
    try {
      const { subject, payload } = request.data;
      const definition = resolveRegisteredRequestSubject(bus, subject);
      const schema = bus.getSchema(subject);
      if (definition === undefined || schema === undefined || !isRequestSchema(schema)) {
        return { ok: false, code: 'request-not-granted' };
      }
      const checked = schema.request.safeParse(payload);
      const data: unknown = checked.success ? checked.data : undefined;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, code: CODE_STEP_REQUEST_REJECTED };
      }
      const response = await bus.request(call, definition, { ...data }, { signal });
      const validated = schema.response.safeParse(response);
      const json = JsonValueSchema.safeParse(validated.success ? validated.data : undefined);
      return json.success ? { ok: true, response: json.data } : { ok: false, code: 'request-failed' };
    } catch (error) {
      const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
      const denied =
        typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === ACCESS_DENIED_ERROR_CODE;
      return { ok: false, code: denied ? 'request-not-granted' : 'request-failed' };
    }
  };
}

/**
 * Allocate a local launch site only when an authored step starts a process.
 * @param options - Caller authority, workspace, and the running step.
 * @returns The two public capabilities and the scope's close operation.
 */
export function bindCallerLocalStepCapabilities(options: {
  bus: IMakaioBus;
  call: CallContext;
  signal: AbortSignal;
  workspace: string;
  stepId: string;
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
}): Pick<StepContext, 'request' | 'launchProcess'> & { close(): Promise<void> } {
  const { bus, call, signal, workspace, stepId } = options;
  const owner = { kind: 'step' as const, stepId, execution: 1 };
  const open = async () => {
    const home = await mkdtemp(join(tmpdir(), 'makaio-local-step-'));
    const { launcher } = createLocalLauncher({
      workspaceRoot: workspace,
      stepHomeRoot: join(home, 'steps'),
      runtimeHomeRoot: join(home, 'runtime'),
    });
    return { home, launcher };
  };
  let site: Promise<Awaited<ReturnType<typeof open>> | undefined> | undefined;
  return {
    request: bindRequest(bus, call, signal),
    launchProcess: async (input) => {
      const parsed = CodeStepLaunchInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, code: CODE_STEP_INVALID_REQUEST };
      if (signal.aborted) return { ok: false, code: 'site-unreachable' };
      const { program, args, cwd, stdin } = parsed.data;
      const opened = await (site ??= open().catch(() => undefined));
      if (opened === undefined || signal.aborted) return { ok: false, code: 'site-unreachable' };
      const process = opened.launcher.launch({
        owner,
        command: program,
        args,
        cwd,
        stdin,
        signal,
        env: options.env,
        timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTOR_CONFIG.stepTimeoutMs,
        output: { kind: 'capture', limitBytes: STEP_OUTPUT_LIMIT_BYTES },
      });
      const { stdout, stderr, stdin: inputStream } = process;
      // Every accepted launch requests capture. A handle without stdout never started.
      if (!(stdout instanceof ReadableStream)) {
        const { refusal } = await process.result;
        return { ok: false, code: refusal ?? 'site-unreachable' };
      }
      const result = process.result.then(({ status, exitCode }) => ({ status, exitCode }));
      // Node's toWeb adapters return WHATWG streams. Their declarations differ from the DOM's.
      return {
        ok: true,
        handle: {
          result,
          stdin: inputStream,
          stdout,
          stderr: stderr instanceof ReadableStream ? stderr : undefined,
        },
      };
    },
    async close() {
      if (site === undefined) return;
      const opened = await site;
      if (opened === undefined) return;
      const evidence = await opened.launcher.closeOwner(owner);
      if (evidence.kind !== 'quiescent') throw new Error('Local step process closure could not be confirmed');
      await rm(opened.home, { recursive: true, force: true });
    },
  };
}
