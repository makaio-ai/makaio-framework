import type { CallContext, PartyRef, SubjectDefinition } from '@makaio/core';
import { implicitOwn } from './carrier.js';
import { invalidSubjectDefinitionError } from '../utils/message-safeguards.js';
import { InvalidCallContextError, isMintedCallContext } from './mint.js';

/**
 * The arguments of one send after the two overload forms were resolved.
 *
 * `payload` and `options` are not narrowed here; the send operation narrows
 * them to the parameter types of the method it calls.
 */
export interface NormalizedSend {
  /** The context to send with: the passed call (call form) or the carrier's implicit own context (own form). */
  readonly call: CallContext;
  /** The subject being sent. */
  readonly subject: SubjectDefinition;
  /** The payload as passed. */
  readonly payload: unknown;
  /** The options as passed. */
  readonly options: unknown;
}

/**
 * Read a subject definition as the subject factories build it into a detached, frozen snapshot.
 *
 * Every built subject (`nestSubjectDefinitions`, the namespace wildcard
 * `$all`, hand-built definitions such as the workflow cancel subjects) carries
 * a string `subject` and a non-null object `$meta` with a string `namespace`
 * and a boolean `isRequest`. An object that merely has a `$meta` key is not a
 * subject definition, and a minted call context never is one (it has no
 * `subject`).
 *
 * The snapshot holds `subject` and a shallow copy of the own enumerable properties of
 * `$meta`. Every property is read exactly once, and the checks run on the copied values, so
 * the subject that is checked is the subject that is dispatched even when the argument is a
 * getter-backed object or a proxy that answers differently on each read. A throwing getter
 * or a revoked proxy yields `undefined` like any other non-subject. The send operations reject
 * `undefined` themselves; this is the only function that reads the sender's object.
 * @param value - Anything.
 * @returns The frozen snapshot, or `undefined` when `value` does not have that runtime shape.
 */
export function snapshotSubjectDefinition(value: unknown): SubjectDefinition | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const subject: unknown = Reflect.get(value, 'subject');
    const meta: unknown = Reflect.get(value, '$meta');
    if (typeof subject !== 'string' || typeof meta !== 'object' || meta === null) return undefined;
    const metaCopy: Record<string, unknown> = Object.fromEntries(Object.entries(meta));
    if (typeof metaCopy.namespace !== 'string' || typeof metaCopy.isRequest !== 'boolean') return undefined;
    // The checks above are the runtime shape of SubjectDefinition; the remaining $meta fields are copied as they are.
    return Object.freeze({ subject, $meta: Object.freeze(metaCopy) }) as SubjectDefinition;
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` is a subject definition as the subject factories build it.
 * @param value - Anything.
 * @returns `true` for a value with the runtime shape described at {@link snapshotSubjectDefinition}.
 */
export function isSubjectDefinition(value: unknown): value is SubjectDefinition {
  return snapshotSubjectDefinition(value) !== undefined;
}

/**
 * Resolve the two overload forms of a send operation.
 *
 * - Call form `(call, subject, payload, options?)`: the first argument is a minted call context.
 * - Own form `(subject, payload, options?)`: the first argument is a subject definition; the send
 *   carries the carrier's {@link implicitOwn} context.
 *
 * A value that is not minted never becomes own work unless it is a subject definition. The
 * returned subject is a detached, frozen snapshot (see {@link snapshotSubjectDefinition}) in both
 * forms, or the send is rejected: the object the sender passed is never returned and never read
 * again, so the subject that is checked is the subject that is dispatched. In call form a second
 * argument that has no snapshot is rejected here with the error `validateMessage` raises for a
 * missing definition. The snapshot is not validated further here (namespace, kind, wildcards):
 * the send operations of a bus run `validateMessage` on it, a direct channel builds its channel
 * protocol subject from it; both pass the call through `enterSend`.
 * @param context - The shared bus context of the sending instance.
 * @param carrier - The carrier of the sending bus instance.
 * @param method - The send operation being performed, named in the invalid-subject error of the call form.
 * @param args - The arguments of the send operation, in either form.
 * @returns The call, subject snapshot, payload and options of the send.
 * @throws InvalidCallContextError When the first argument is neither a minted call context nor a subject definition.
 * @throws Error When the first argument is a minted call context and the second is not a subject definition.
 */
export function normalizeSendArgs(
  context: object,
  carrier: PartyRef,
  method: 'emit' | 'request',
  args: readonly unknown[],
): NormalizedSend {
  const first: unknown = args[0];
  if (isMintedCallContext(first)) {
    const callSubject = snapshotSubjectDefinition(args[1]);
    if (callSubject === undefined) throw invalidSubjectDefinitionError(method);
    return {
      call: first,
      subject: callSubject,
      payload: args[2],
      options: args[3],
    };
  }
  const subject = snapshotSubjectDefinition(first);
  if (subject !== undefined) {
    return { call: implicitOwn(context, carrier), subject, payload: args[1], options: args[2] };
  }
  throw new InvalidCallContextError(
    'Invalid send: the first argument is neither a minted call context nor a subject definition',
  );
}
