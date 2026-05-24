import type { IStepRunner } from '@makaio/contracts';
import type { NodeStepRunnerFactoryOptions } from './types.js';
import { PiscinaStepRunner } from './piscina-step-runner.js';
import { ChildProcessStepRunner } from './child-process-step-runner.js';
import { DockerStepRunner } from './docker-step-runner.js';

/**
 * Create a step runner based on the Node runtime configuration.
 *
 * Returns `undefined` for `in-process` mode — the workflow engine falls back
 * to its built-in in-process execution. For all isolation modes, returns a
 * concrete runner instance:
 * - `piscina`: Worker-thread pool via Piscina
 * - `child-process`: Isolated Node.js child processes
 * - `docker`: Docker containers for full OS-level isolation
 * @param options - Node step runner factory configuration.
 * @returns A step runner instance, or `undefined` to use the engine default.
 */
export function createNodeStepRunner(options: NodeStepRunnerFactoryOptions): IStepRunner | undefined {
  switch (options.mode) {
    case 'in-process':
      return undefined;
    case 'piscina':
      return new PiscinaStepRunner(options);
    case 'child-process':
      return new ChildProcessStepRunner(options);
    case 'docker':
      return new DockerStepRunner(options);
  }
}
