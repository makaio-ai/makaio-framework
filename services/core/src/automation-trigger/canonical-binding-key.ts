import type { JsonValue } from '@makaio/contracts';
import { canonicalStringify } from '@makaio/utils';

/**
 * Canonicalizes a JSON record into the exact value its binding key encodes.
 *
 * Defined as the parse of the canonical serialization rather than as a separate
 * traversal, which is what makes the guarantee exact instead of merely intended:
 * the record handed to `activate` is by construction the value
 * {@link createCanonicalBindingKey} derived its key from, so no parameter can
 * ever disagree with the key it produced.
 *
 * Two normalizations follow from that definition. Object keys come back sorted,
 * so `activate` observes a deterministic property order. Negative zero comes back
 * as `0`, because that is what serialization does to it — without this, a binding
 * could hand `activate` a `-0` the key cannot express, and two parameter sets that
 * share one activation would disagree about what that activation was given.
 * @param record - Schema-parsed, JSON-validated binding parameters.
 * @returns A structurally equal record in canonical form.
 */
export function canonicalizeJsonRecord(record: Record<string, JsonValue>): Record<string, JsonValue> {
  // Single narrowing cast: `JSON.parse` is untyped, and the input was already
  // validated as a JSON record, so the round trip preserves that type.
  return JSON.parse(canonicalStringify(record)) as Record<string, JsonValue>;
}

/**
 * Computes the canonical sharing key for an automation trigger binding.
 *
 * Two bindings share a single live activation exactly when they produce the same
 * key. Callers must pass the **schema-parsed** parameters so that defaults and
 * normalizing transforms are already applied — otherwise two bindings that mean
 * the same thing would activate the underlying source twice.
 *
 * The key format is `<kind>:<canonical-json(params)>`. Key ordering is handled by
 * the canonical serialization itself, so passing an already-canonicalized record
 * yields the same key as passing the raw parsed one.
 * @param kind - Canonical trigger kind, e.g. `demo.assignment`.
 * @param params - Schema-parsed, JSON-validated binding parameters.
 * @returns A stable string key identifying the shared binding.
 */
export function createCanonicalBindingKey(kind: string, params: Record<string, JsonValue>): string {
  return `${kind}:${canonicalStringify(params)}`;
}
