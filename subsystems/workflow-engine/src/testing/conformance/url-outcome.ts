/**
 * An outcome type that is codec-serializable but not structured-cloneable.
 *
 * `URL` satisfies the codec contract exactly — it serializes to its `href` and
 * reconstructs from it — while `structuredClone` refuses it outright. It is
 * therefore the outcome type that catches a realization which clones a
 * submission instead of taking it through the codec: such a realization
 * rejects a conforming owner outcome before the codec is ever consulted.
 * @packageDocumentation
 */
import type { OutcomeCodec } from '../../execution-attempt-repository.js';

/**
 * Read a URL out of either form the port presents to {@link urlOutcomeCodec}.
 *
 * The port calls `parse` on ingress with the submitted `URL` and again on
 * read-back with the `href` string the durable text carries. Both are
 * accepted; each yields a fresh instance, so a committed outcome is never the
 * submitter's object.
 * @param input - Value to interpret.
 * @returns The URL the value denotes.
 * @throws When the value is neither a URL nor an absolute URL string.
 */
function readUrl(input: unknown): URL {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input === 'string') return new URL(input);
  throw new Error('UrlOutcome requires a URL or an absolute URL string');
}

/** Codec for an outcome no `structuredClone` can copy. */
export const urlOutcomeCodec: OutcomeCodec<URL> = {
  parse: (input) => readUrl(input),
  serialize: (outcome) => JSON.stringify(outcome.href),
};
