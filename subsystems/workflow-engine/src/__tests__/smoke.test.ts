import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow engine smoke', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  it('runs shell workflow from bus start through checkpoints and lifecycle events', async () => {
    const workflow = createWorkflowDefinition({
      id: 'smoke-test',
      name: 'Smoke Test',
      inputs: [{ name: 'greeting', type: 'string', default: 'Hello from Makaio' }],
      steps: [
        { id: 'create-workspace', type: 'shell', command: ['mkdir', '-p', '/tmp/makaio-smoke'] },
        {
          id: 'write-file',
          type: 'shell',
          command: ['sh', '-c', 'echo "{{ inputs.greeting }}" > /tmp/makaio-smoke/output.txt'],
          needs: ['create-workspace'],
        },
        { id: 'verify', type: 'shell', command: ['cat', '/tmp/makaio-smoke/output.txt'], needs: ['write-file'] },
        { id: 'cleanup', type: 'shell', command: ['rm', '-rf', '/tmp/makaio-smoke'], needs: ['verify'] },
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
    expect(execution?.steps.verify?.result?.trim()).toBe('Hello from Makaio');
    expect(events).toEqual(['create-workspace', 'write-file', 'verify', 'cleanup', 'execution.completed']);
  });
});
