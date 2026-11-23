import { z } from 'zod';
import { WorkerContributionManifestSchema } from '../workflow/worker.js';

/** Non-secret realization inputs selected for an allocated Worker's Runtime. */
export const WorkerRuntimeInputsSchema = z
  .object({
    /** Exact worker-local contribution packages selected during dispatch. */
    workerManifest: WorkerContributionManifestSchema,
  })
  .strict();

/** Selected Runtime composition, separate from the owner's instruction. */
export type WorkerRuntimeInputs = z.infer<typeof WorkerRuntimeInputsSchema>;
