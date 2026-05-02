import type { TaskMeta } from 'vitest';
import type { RunnerTask } from 'vitest/node';

/**
 * Vitest TaskMeta module augmentation for conformance test metadata tracking.
 *
 * Enables test reporters and shared test utilities to attach adapter/agent
 * identifiers and bus logs to individual test results. Declared once here
 * and picked up globally via the root tsconfig include.
 */
declare module 'vitest' {
  interface TaskMeta {
    adapterId?: string[];
    agentId?: string[];
    sessionId?: string[];
    adapterSessionId?: string[];
    busLogs: Array<{ timestamp: number; content: unknown }>;
    logPath?: string;
    stopLogs?: () => void;
  }
}

declare module 'vitest/node' {
  interface TestCase {
    task: RunnerTask & { meta: TaskMeta };
  }

  interface TestModule {
    task: RunnerTask & {
      meta: TaskMeta;
      tasks: Array<RunnerTask & { meta: TaskMeta }>;
    };
  }
}
