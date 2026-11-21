import { z } from 'zod';

/** Zod schema for {@link JobRunId}. */
export const JobRunIdSchema = z.string().min(1);

/** Identifier of a job run. */
export type JobRunId = z.infer<typeof JobRunIdSchema>;

/** Zod schema for {@link StepId}. */
export const StepIdSchema = z.string().min(1);

/** Identifier of a step. */
export type StepId = z.infer<typeof StepIdSchema>;
