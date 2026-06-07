import { z } from 'zod';

/**
 * Strategy a WorkerNode provider uses when a workflow reaches a suspension point.
 *
 * - `wait-in-process`: the worker blocks in-process until the gate is resolved
 *   (default, suitable for local Piscina threads and in-process runners).
 * - `exit-and-redispatch`: the worker exits and is re-dispatched via a fresh
 *   `provision()` call when the gate resolves; state must be externally persisted.
 * - `exit-and-resume`: the worker exits and is later resumed on its original
 *   provider-managed environment via `resumeExecution()`; requires provider support.
 */
export const SuspensionStrategySchema = z.enum(['wait-in-process', 'exit-and-redispatch', 'exit-and-resume']);

/** Provider suspension behavior selected for a workflow execution. */
export type SuspensionStrategy = z.infer<typeof SuspensionStrategySchema>;
