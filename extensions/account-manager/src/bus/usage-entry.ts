import { z } from 'zod';

/**
 * Zod schema for a single persisted usage observation for one rate-limit window.
 *
 * Mirrors the `UsageEntry` interface that the writer appends to JSONL files.
 */
export const UsageEntrySchema = z.object({
  /** Observation timestamp (epoch ms) — when the snapshot was taken, not API time. */
  ts: z.number().int().finite(),
  /** Window slug, e.g. `"5h"`, `"7d"`, `"7d-sonnet"`. */
  windowId: z.string().min(1),
  /** Current utilization percentage (0–100). */
  utilization: z.number().finite().min(0).max(100),
  /** Epoch ms when this window resets. */
  resetsAt: z.number().int().finite(),
  /** Whether the account is blocked in this window. */
  blocked: z.boolean(),
});

/** Inferred TypeScript type for {@link UsageEntrySchema}. */
export type UsageEntry = z.infer<typeof UsageEntrySchema>;
