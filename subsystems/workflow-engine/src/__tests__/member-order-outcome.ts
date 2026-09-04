/**
 * An outcome whose decoded form still carries the member order of its text.
 *
 * `sameDurableOutcome` judges two texts the same outcome when they carry the
 * same members with the same values, whatever order those members are in —
 * which is what makes a worker's honest replay a `duplicate` rather than a
 * `conflict`. Member order is therefore something two texts for one committed
 * outcome can genuinely differ in, and this codec makes that difference
 * observable: `parse` copies the members in the order it received them, so a
 * decoded outcome reports the order of the text it was decoded from.
 *
 * It is what catches a boundary that settles a waiter from the text the
 * *retry* rendered instead of the text the attempt *stored*: both are the same
 * outcome, so no value comparison can tell them apart, but only one of them is
 * the representation the attempt holds.
 * @packageDocumentation
 */
import type { OutcomeCodec } from '../execution-attempt-repository.js';

/** Owner outcome whose member order is part of what a test can observe. */
export type MemberOrderOutcome = Readonly<Record<string, number>>;

/**
 * Read a member-order outcome out of either form the port presents.
 *
 * The port calls `parse` on ingress with the submitted object and again on
 * read-back with the object `JSON.parse` produced from the durable text. Both
 * are plain records of numbers, and both are copied member by member, so the
 * result reports the order of whichever one it came from.
 * @param input - Value to interpret.
 * @returns A fresh record carrying the input's members in the input's order.
 * @throws When the value is not a record whose every member is a number.
 */
function readMembers(input: unknown): MemberOrderOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('MemberOrderOutcome requires a record of numbers');
  }
  const members: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'number') throw new Error('MemberOrderOutcome requires a record of numbers');
    members[key] = value;
  }
  return members;
}

/** Codec whose decoded outcome preserves the member order of its durable text. */
export const memberOrderCodec: OutcomeCodec<MemberOrderOutcome> = {
  parse: (input) => readMembers(input),
  serialize: (outcome) => JSON.stringify(readMembers(outcome)),
};
