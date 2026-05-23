import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { asExecutable, createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  setupWorkflowExecutorWithSubagentServiceTest,
  teardownWorkflowExecutorWithSubagentServiceTest,
  type WorkflowExecutorTestSetup,
  type WorkflowExecutorWithSubagentServiceTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow engine smoke', () => {
  let setup: WorkflowExecutorTestSetup | undefined;
  let tempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'makaio-smoke-'));
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('runs shell workflow from bus start through checkpoints and lifecycle events', async () => {
    if (!setup || !tempDir) {
      throw new Error('Smoke test setup did not initialize.');
    }

    const outputPath = join(tempDir, 'output.txt');
    const workflow = createWorkflowDefinition({
      id: 'smoke-test',
      name: 'Smoke Test',
      inputs: [{ name: 'greeting', type: 'string', default: 'Hello from Makaio' }],
      steps: [
        {
          id: 'write-file',
          type: 'shell',
          command: [
            'node',
            '-e',
            'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], process.argv[2]);',
            outputPath,
            '{{ inputs.greeting }}',
          ],
        },
        {
          id: 'verify',
          type: 'shell',
          command: [
            'node',
            '-e',
            'const fs = require("node:fs"); process.stdout.write(fs.readFileSync(process.argv[1], "utf8"));',
            outputPath,
          ],
          needs: ['write-file'],
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const events: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, (ctx) => {
        events.push(ctx.payload.stepId);
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, () => {
        events.push('execution.completed');
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { greeting: 'Hello from Makaio' },
    });

    await vi.waitFor(() => expect(events.at(-1)).toBe('execution.completed'), { timeout: 10_000 });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('completed');
    expect(asExecutable(execution?.steps.verify)?.result?.trim()).toBe('Hello from Makaio');
    expect(events).toEqual(['write-file', 'verify', 'execution.completed']);
  });
});

describe('workflow engine agent smoke — real SubagentService path', () => {
  let setup: WorkflowExecutorWithSubagentServiceTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorWithSubagentServiceTest();
  });

  afterEach(async () => {
    if (setup) {
      await teardownWorkflowExecutorWithSubagentServiceTest(setup);
      setup = undefined;
    }
  });

  it('runs an agent step through SubagentService → AdapterSubjects.startAgent and back', async () => {
    if (!setup) {
      throw new Error('Smoke test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'agent-smoke',
      name: 'Agent Smoke',
      steps: [
        {
          id: 'review',
          type: 'agent',
          adapter: 'claude-code',
          prompt: 'Review {{ inputs.file }}',
          harnessId: 'harness-reviewer',
          contextMode: 'fresh',
        },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const events: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.completed, (ctx) => {
        events.push(ctx.payload.stepId);
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, () => {
        events.push('execution.completed');
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      inputs: { file: 'README.md' },
    });

    await vi.waitFor(() => expect(events.at(-1)).toBe('execution.completed'), { timeout: 10_000 });

    expect(setup.adapterStartCalls[0]).toMatchObject({
      harnessId: 'harness-reviewer',
      initialMessage: 'Review README.md',
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.steps.review?.status).toBe('completed');
    expect(asExecutable(execution?.steps.review)?.result).toBe('completed:Review README.md');
  });
});
