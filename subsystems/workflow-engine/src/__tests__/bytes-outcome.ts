/**
 * An outcome type that cannot be frozen.
 *
 * A non-empty typed array satisfies the codec contract exactly — it serializes
 * to a JSON number array and reconstructs from it — while `Object.freeze`
 * refuses it outright with `Cannot freeze array buffer views with elements`.
 * It is therefore the outcome type that catches a realization which freezes a
 * codec's output: such a realization throws on a conforming owner outcome
 * before any durable decision is reached.
 * @packageDocumentation
 */
import type { OutcomeCodec } from '../execution-attempt-repository.js';

/**
 * Read bytes out of either form the port presents to {@link bytesOutcomeCodec}.
 *
 * The port calls `parse` on ingress with the submitted `Uint8Array` and again
 * on read-back with the number array the durable text carries. Both are
 * accepted; each yields a fresh instance, so a committed outcome is never the
 * submitter's buffer.
 * @param input - Value to interpret.
 * @returns The bytes the value denotes.
 * @throws When the value is neither a `Uint8Array` nor an array of byte values.
 */
function readBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return Uint8Array.from(input);
  if (Array.isArray(input) && input.every((byte) => typeof byte === 'number')) {
    return Uint8Array.from(input as number[]);
  }
  throw new Error('BytesOutcome requires a Uint8Array or an array of byte values');
}

/** Codec for an outcome no `Object.freeze` can accept. */
export const bytesOutcomeCodec: OutcomeCodec<Uint8Array> = {
  parse: (input) => readBytes(input),
  serialize: (outcome) => JSON.stringify(Array.from(outcome)),
};
