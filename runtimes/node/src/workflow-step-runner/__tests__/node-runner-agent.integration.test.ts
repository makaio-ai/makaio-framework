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
 * Integration test for the worker entrypoint orchestration.
 *
 * Verifies the full flow:
 * 1. Boot worker bus (local-only, no WebSocket)
 * 2. Dispatch to shell executor
 * 3. Collect telemetry
 * 4. Return merged result
 *
 * Covers shell orchestration through the legacy step-level worker entrypoint.
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

  it('keeps subagent spawning out of the worker entrypoint', () => {
    const workerEntryPath = resolve(import.meta.dirname, '..', 'worker-entry.ts');
    const workerSource = readFileSync(workerEntryPath, 'utf-8');

    expect(workerSource).not.toContain('SubagentSubjects');
  });

  it('routes legacy worker agent execution through the subagent protocol without the workflow-engine public subpath', () => {
    const agentExecutorPath = resolve(import.meta.dirname, '..', 'worker-agent-executor.ts');
    const source = readFileSync(agentExecutorPath, 'utf-8');

    expect(source).toContain('SubagentSubjects.spawn');
    expect(source).toContain('WorkflowSubjects.resolveRole');
    expect(source).not.toContain('@makaio/subsystem-workflow-engine/workflow-orchestrator');
    expect(source).not.toContain('AdapterSubjects.startAgent');
  });
});
