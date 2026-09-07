import { z } from 'zod';
import { WorkerContributionManifestSchema } from '../workflow/worker.js';
import { SuspensionStrategySchema } from './suspension.js';

/** Non-secret realization inputs selected for an allocated Worker's Runtime. */
export const WorkerRuntimeInputsSchema = z
  .object({
    /** Exact worker-local contribution packages selected during dispatch. */
    workerManifest: WorkerContributionManifestSchema,
    /** Suspension behavior selected for this provider realization. */
    suspensionStrategy: SuspensionStrategySchema,
  })
  .strict();

/** Selected Runtime composition and suspension behavior, separate from the owner's instruction. */
export type WorkerRuntimeInputs = z.infer<typeof WorkerRuntimeInputsSchema>;
