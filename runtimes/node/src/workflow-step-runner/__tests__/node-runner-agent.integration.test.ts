import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StepRunConfig } from '@makaio/contracts';
import { runStepInWorker, type WorkerRunStepParams } from '../worker-entry.js';

/**
 * Create a minimal WorkerRunStepParams for a shell step.
 * @param command - Command array to execute.
 * @param cwd - Working directory for the shell step.
 * @returns Valid WorkerRunStepParams for testing.
 */
function makeShellParams(command: string[], cwd: string): WorkerRunStepParams {
  const config: StepRunConfig = {
    stepId: 'agent-harness-step',
    executionId: 'agent-harness-exec',
    workflowId: 'agent-harness-wf',
    coordinatorSessionId: 'agent-harness-session',
    stepType: 'shell',
    stepDefinition: {
      id: 'agent-harness-step',
      type: 'shell',
      command,
    },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd },
    cancelSubject: 'workflow.cancel.agent-harness-test',
  };

  return {
    config,
    manifest: { packages: [] },
  };
}

/**
 * Encode a JavaScript source string as an importable `data:` URL.
 * @param source - ESM source code.
 * @returns A `data:` URL suitable for dynamic import.
 */
function toDataUrl(source: string): string {
  const encoded = Buffer.from(source).toString('base64');
  return `data:text/javascript;base64,${encoded}`;
}

/** Extension module that contributes a worker-local adapter and toolset. */
const WORKER_AGENT_EXTENSION_MODULE = toDataUrl(`
  const toolset = {
    metadata: { name: 'worker-agent-tools', description: 'worker tools', version: '1.0.0' },
    tools: {
      echo: {
        metadata: { name: 'worker.agent.echo', description: 'echo' },
        inputSchema: {
          safeParse: (value) => ({ success: true, data: value }),
        },
        outputSchema: {
          safeParse: (value) => ({ success: true, data: value }),
        },
        execute: async (input) => ({ success: true, data: { source: 'worker-local', value: input.value } }),
      },
    },
  };

  export default {
    name: 'worker-agent-extension',
    displayName: 'Worker Agent Extension',
    version: '0.1.0',
    tools: {
      createToolsets: () => [toolset],
    },
    adapters: [
      {
        manifest: { name: 'worker-agent-adapter', displayName: 'Worker Agent Adapter', protocols: ['openai'] },
        definition: {
          name: 'worker-agent-adapter',
          displayName: 'Worker Agent Adapter',
          providers: [],
          defaultTimeouts: {
            initialization: 1000,
            acknowledgement: 1000,
            completion: 1000,
            toolApproval: 1000,
            eventWait: 1000,
          },
          createAdapter: async (options) => {
            const bus = options?.globalBus;
            if (!bus) throw new Error('missing worker bus');
            return {
              adapterId: 'worker-agent-adapter',
              name: 'worker-agent-adapter',
              async init() {
                bus.on(options.adapterSubjects.startAgent, async (ctx) => {
                  const toolResult = await bus.request(options.toolSubjects.execute, {
                    toolName: 'worker.agent.echo',
                    input: { value: ctx.payload.initialMessage },
                    adapterId: 'worker-agent-adapter',
                    adapterName: 'worker-agent-adapter',
                  });
                  ctx.setResult({
                    success: true,
                    agentId: 'worker-agent-integration',
                    adapterId: 'worker-agent-adapter',
                    adapterSessionId: 'worker-agent-session',
                    sessionId: 'worker-makaio-session',
                  });
                  setTimeout(() => {
                    void bus.emit(options.agentSubjects.complete, {
                      agentId: 'worker-agent-integration',
                      adapterId: 'worker-agent-adapter',
                      adapterName: 'worker-agent-adapter',
                      adapterSessionId: 'worker-agent-session',
                      messageId: 'worker-agent-message',
                      message: toolResult.success ? JSON.stringify(toolResult.data) : 'tool failed',
                      outcome: 'completed',
                    });
                  }, 0);
                });
              },
            };
          },
        },
      },
    ],
  };
`);

const tempDirs: string[] = [];

/**
 * Create and track a temp directory for cleanup after each test.
 * @returns Realpath-resolved temporary directory.
 */
function createTempDir(): string {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-harness-')));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * Create WorkerRunStepParams for an agent step.
 * @param cwd - Working directory for the worker runtime.
 * @returns Valid WorkerRunStepParams for testing.
 */
function makeAgentParams(cwd: string): WorkerRunStepParams {
  const config: StepRunConfig = {
    stepId: 'worker-agent-step',
    executionId: 'worker-agent-exec',
    workflowId: 'worker-agent-wf',
    coordinatorSessionId: 'worker-agent-session',
    stepType: 'agent',
    stepDefinition: {
      id: 'worker-agent-step',
      type: 'agent',
      adapter: 'worker-agent-adapter',
      prompt: 'hello from worker',
    },
    resolvedInputs: {},
    busAuth: { kind: 'none' },
    platformDefaults: { cwd },
    cancelSubject: 'workflow.cancel.worker-agent-test',
  };

  return {
    config,
    manifest: {
      packages: [{ name: 'worker-agent-extension', importPath: WORKER_AGENT_EXTENSION_MODULE }],
    },
  };
}

/**
 * Integration test for the worker entrypoint orchestration.
 *
 * Verifies the full flow:
 * 1. Boot worker bus (local-only, no WebSocket)
 * 2. Dispatch to shell executor
 * 3. Collect telemetry
 * 4. Return merged result
 *
 * Covers shell orchestration and a manifest-contributed local adapter/toolset
 * without requiring an external bus server.
 */
describe('Worker Agent Harness (integration)', { timeout: 30_000 }, () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs shell step through full worker entrypoint orchestration', async () => {
    const tempDir = createTempDir();
    const params = makeShellParams(['node', '-e', 'process.stdout.write("harness-ok")'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('harness-ok');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('collects telemetry with zero token usage for shell steps', async () => {
    const tempDir = createTempDir();
    const params = makeShellParams(['node', '-e', 'process.stdout.write("telemetry-test")'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
    // Shell steps produce no token usage — telemetry collector finds nothing
    expect(result.telemetry.tokenUsage).toBeUndefined();
    expect(result.telemetry.toolCalls).toBeUndefined();
  });

  it('boots bus, executes step, and closes bus cleanly on failure', async () => {
    const tempDir = createTempDir();
    const params = makeShellParams(['node', '-e', 'process.exit(1)'], tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('failed');
    expect(result.telemetry.duration).toBeGreaterThan(0);
  });

  it('executes a manifest-contributed agent and toolset inside the worker', async () => {
    const tempDir = createTempDir();
    const params = makeAgentParams(tempDir);

    const result = await runStepInWorker(params);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('{"source":"worker-local","value":"hello from worker"}');
  });

  it('does not import or reference SubagentSubjects in the worker entry', () => {
    // The isolation guarantee: worker-entry must not depend on SubagentSubjects.
    // This ensures the worker process doesn't accidentally spawn subagents directly.
    const workerEntryPath = resolve(import.meta.dirname, '..', 'worker-entry.ts');
    const workerSource = readFileSync(workerEntryPath, 'utf-8');

    expect(workerSource).not.toContain('SubagentSubjects');
  });

  it('does not import or reference SubagentSubjects in any worker module', () => {
    // Verify that no file in the workflow-step-runner directory imports SubagentSubjects.
    // This proves complete isolation from the subagent spawn path.
    const workerDir = resolve(import.meta.dirname, '..');
    const filesToCheck = ['worker-entry.ts', 'worker-boot.ts', 'worker-shell-executor.ts', 'worker-agent-executor.ts'];

    for (const file of filesToCheck) {
      const filePath = join(workerDir, file);
      const source = readFileSync(filePath, 'utf-8');
      expect(source, `${file} must not reference SubagentSubjects`).not.toContain('SubagentSubjects');
    }
  });
});
