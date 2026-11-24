/**
 * The three denial reasons the core itself produces while resolving a right, as one exported
 * constant object so neither the kernel nor a test repeats the literal string.
 */
export const RightDenialReason = {
  /** No active extension declares the right asked about. */
  rightUnknown: 'right-unknown',
  /** The question's context fails the right's own JSON schema. */
  contextInvalid: 'context-invalid',
  /** An answer source did not answer: it threw, its promise rejected, it missed its deadline, or its answer failed to parse. */
  sourceUnavailable: 'source-unavailable',
} as const;

/** One of the three denial reasons the core itself produces while resolving a right. */
export type RightDenialReason = (typeof RightDenialReason)[keyof typeof RightDenialReason];
