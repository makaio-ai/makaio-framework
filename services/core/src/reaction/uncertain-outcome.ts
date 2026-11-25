import { FrameworkReactionFailureCodeSchema, type ReactionOutcome } from '@makaio/contracts';

/**
 * Classifies an attempt for which no handler outcome is available.
 * @param keyed - Whether repeating the attempt with its existing key is safe.
 * @param reason - Cause of the uncertainty.
 * @returns Retry disposition or terminal unknown outcome.
 */
export function uncertainReactionOutcome(keyed: boolean, reason: string): ReactionOutcome {
  return keyed
    ? { state: 'retry', reason }
    : { state: 'failed', code: FrameworkReactionFailureCodeSchema.enum['outcome-unknown'], reason };
}
