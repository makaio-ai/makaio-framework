import { z } from 'zod';

/**
 * Closed set of reasons a session cannot be resumed or forked natively
 * on the current machine.
 */
export const NativeLocalityReasonSchema = z.enum([
  'adapter-unsupported',
  'adapter-mismatch',
  'no-adapter-session',
  'missing-machine-id',
  'machine-mismatch',
  'cwd-mismatch',
  'transforms-present',
  'compression-present',
  'connector-swap',
  'mid-history-unsupported',
  'hybrid-imported-orchestrated',
  'native-attempt-failed',
  'agent-already-started',
  'fork-point-unresolvable',
]);

export type NativeLocalityReason = z.infer<typeof NativeLocalityReasonSchema>;

/**
 * Verdict produced by the locality evaluator for a given session.
 *
 * - `native`: The session is owned by this machine and can be resumed or
 *   forked natively without any history injection.
 * - `degrade`: The session is local but a structural constraint (e.g. active
 *   transforms, compression, connector swap) prevents native operation.
 *   The adapter must fall back to fresh mode.
 * - `foreign`: The session's provider-native store lives on another machine.
 *   Native operation is not possible without cross-machine coordination.
 */
export const NativeLocalityVerdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }),
  z.object({
    kind: z.literal('degrade'),
    /** Why native operation was degraded. */
    reason: NativeLocalityReasonSchema,
  }),
  z.object({
    kind: z.literal('foreign'),
    /** Machine that owns the provider-native session store. */
    machineId: z.string(),
  }),
]);

export type NativeLocalityVerdict = z.infer<typeof NativeLocalityVerdictSchema>;

/**
 * Directive passed from the session orchestrator to the adapter when a
 * provider-native fork is requested.
 *
 * The adapter uses these fields to invoke the provider's branching API
 * rather than replaying history into a fresh session.
 */
export const NativeForkDirectiveSchema = z.object({
  /** Makaio session ID of the session being forked from. */
  sourceSessionId: z.string(),
  /** Provider-native session ID to branch from. */
  sourceAdapterSessionId: z.string(),
  /**
   * Provider-native message/checkpoint ID at which to branch.
   * Only supplied when the adapter declares `nativeForkAtMessage` capability.
   */
  forkPointMessageId: z.string().optional(),
  /**
   * Working directory override for the forked session.
   * Only applied when the adapter declares `nativeForkCwd` capability.
   */
  targetWorkingDirectory: z.string().optional(),
});

export type NativeForkDirective = z.infer<typeof NativeForkDirectiveSchema>;
