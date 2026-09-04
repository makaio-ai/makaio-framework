/**
 * A non-workflow outcome, so the generic boundary is proved shape-agnostic.
 *
 * Two properties are deliberate. The outcome is a bare number, so a committed
 * `0` is a committed outcome that a truthiness probe would read as absence —
 * the port answers a replay of it as `duplicate`, never as a second `accepted`.
 * And `serialize` writes an envelope rather than the outcome itself, so a
 * realization that read its durable column back without going through `parse`
 * would report `{ counter: n }` where the port owes `n`.
 * @packageDocumentation
 */
import type { OutcomeCodec } from '../execution-attempt-repository.js';

/** Owner outcome used wherever a suite needs a non-workflow outcome type. */
export type CounterOutcome = number;

/**
 * Read a counter out of either form the port presents to {@link counterCodec}.
 *
 * The port calls `parse` twice for different reasons: on ingress with a
 * submitted outcome, and on read-back with `JSON.parse(serialize(outcome))`.
 * Both are accepted here; anything else is rejected.
 * @param input - Value to interpret.
 * @returns The counter the value denotes.
 * @throws When the value is neither a number nor a durable counter envelope.
 */
function readCounter(input: unknown): CounterOutcome {
  if (typeof input === 'number') return input;
  if (typeof input === 'object' && input !== null) {
    const envelope: unknown = (input as { counter?: unknown }).counter;
    if (typeof envelope === 'number') return envelope;
  }
  throw new Error('CounterOutcome requires a numeric counter');
}

/** Codec whose durable text is deliberately not `JSON.stringify(outcome)`. */
export const counterCodec: OutcomeCodec<CounterOutcome> = {
  parse: (input) => readCounter(input),
  serialize: (outcome) => JSON.stringify({ counter: outcome }),
};

/**
 * Build a value the codec must refuse, without an `as unknown as` cast.
 *
 * `JSON.parse` is the honest source of an outcome-shaped value nobody
 * type-checked: it is exactly what a durable realization or a wire hop hands
 * the codec, and it lets the caller state the submission in the type the
 * boundary declares.
 * @returns A value typed as an outcome that {@link counterCodec} rejects.
 */
export function invalidCounterOutcome(): CounterOutcome {
  return JSON.parse('"not-a-number"') as CounterOutcome;
}

/**
 * The same counter, boxed, for cases that need object identity to be visible.
 *
 * A bare number makes `toBe` a value comparison, so an assertion that the
 * committed outcome — and not the submitter's copy of it — reached a
 * collaborator cannot bite: two equal numbers are the same value however they
 * were obtained. Boxing the counter turns that assertion back into an identity
 * witness, because the repository commits a frozen clone that is never the
 * object the caller submitted.
 */
export interface BoxedCounterOutcome {
  /** The counter this outcome reports. */
  readonly counter: number;
}

/** Codec for {@link BoxedCounterOutcome}; the durable text is the outcome itself. */
export const boxedCounterCodec: OutcomeCodec<BoxedCounterOutcome> = {
  parse: (input) => ({ counter: readCounter(input) }),
  serialize: (outcome) => JSON.stringify(outcome),
};

/**
 * Codec that normalizes while serializing, so the durable value differs.
 *
 * The outcome contract only requires `parse(JSON.parse(serialize(outcome)))`
 * to succeed — not to equal the outcome the codec was handed. This codec
 * exercises that freedom: it accepts any number and persists its truncation,
 * so `1.2` and `1.7` are the same durable counter and `2.5` is a different
 * one. It is what makes "equality is decided over the durable representation"
 * an assertable rule rather than a claim no realization can be caught
 * violating.
 */
export const roundingCounterCodec: OutcomeCodec<CounterOutcome> = {
  parse: (input) => readCounter(input),
  serialize: (outcome) => JSON.stringify({ counter: Math.trunc(outcome) }),
};

/**
 * An outcome carrying the generation of the durable text it came from.
 *
 * The companion of {@link generationCounterCodec}: a submitter states the
 * generation it holds, and every serialization writes the next one.
 */
export interface GenerationCounterOutcome {
  /** The counter this outcome reports. */
  readonly counter: number;
  /** How many serializations produced the text this outcome was read from. */
  readonly generation: number;
}

/**
 * Read a generation counter out of either form the port presents.
 *
 * A missing generation is `0`: that is the form a caller submits before any
 * text exists, while a read-back always carries the generation its text was
 * written with.
 * @param input - Value to interpret.
 * @returns The generation counter the value denotes.
 * @throws When the value is not a generation counter envelope.
 */
function readGenerationCounter(input: unknown): GenerationCounterOutcome {
  if (typeof input === 'object' && input !== null) {
    const { counter, generation } = input as { counter?: unknown; generation?: unknown };
    if (typeof counter === 'number' && (generation === undefined || typeof generation === 'number')) {
      return { counter, generation: generation ?? 0 };
    }
  }
  throw new Error('GenerationCounterOutcome requires a numeric counter');
}

/**
 * Deterministic codec whose serialization is deliberately not a fixed point.
 *
 * `serialize` writes one generation more than the outcome it was handed, so
 * `serialize(parse(JSON.parse(serialize(o))))` never equals `serialize(o)`.
 * The increment is derived from the argument alone — the same outcome always
 * renders to the same text — which is what the codec contract requires:
 * determinism, not idempotence.
 *
 * It separates the two rules a retry could be decided by. Comparing the text
 * an attempt stored against the text a submission would store answers the
 * honest replay as `duplicate`; re-serializing the decoded stored value
 * answers it as `conflict`, because that second serialization writes a
 * generation the first commit never wrote.
 */
export const generationCounterCodec: OutcomeCodec<GenerationCounterOutcome> = {
  parse: (input) => readGenerationCounter(input),
  serialize: (outcome) => JSON.stringify({ counter: outcome.counter, generation: outcome.generation + 1 }),
};
