import { parentPort } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';

const { acceptPiscinaBootstrapHandoff } = await tsImport('../../piscina-bootstrap-handoff.ts', import.meta.url);
const { createWorkflowWorkerReadyMessage } = await tsImport('../../worker-ready-message.ts', import.meta.url);

// Real pool fixture: its gate controls task occupancy, not the handoff itself.
/**
 * Exercise the real bootstrap handoff before waiting for the test's release gate.
 * @param task - Pool task carrying workflow inputs and an optional Attempt binding.
 * @returns The completed workflow result after the release gate opens.
 */
export default async function run(task) {
  const input = task.config.inputs;
  if (input.started) writeFileSync(input.started, 'started');
  if (task.kind === 'attempt-bound') {
    await acceptPiscinaBootstrapHandoff(task);
    parentPort.postMessage(
      createWorkflowWorkerReadyMessage(task.config.executionId, task.config.cancelSubject, task.executionAttemptId),
    );
  }
  if (input.release) {
    while (!existsSync(input.release)) await delay(10);
  }
  return { executionId: task.config.executionId, workflowId: task.config.workflowId, status: 'completed' };
}
