import { z } from 'zod';

/** Explicit workflow artifact reference supplied by an execution starter. */
export const WorkflowArtifactRefSchema = z.object({
  /** Artifact kind string. */
  kind: z.string().min(1),
  /** Artifact identifier within its kind. */
  id: z.string().min(1),
});

export type WorkflowArtifactRef = z.infer<typeof WorkflowArtifactRefSchema>;
