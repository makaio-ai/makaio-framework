import type { JsonValue } from '../shared/json-value.js';

/**
 * Why an operator-supplied configuration entry cannot be turned into a
 * configuration object.
 *
 * The values describe the shape of the problem, not its origin: the layer that
 * produces entries is free to source them from anywhere, and reports the
 * concrete origin through {@link ExtensionOperatorConfigFailure.source}.
 */
export type ExtensionOperatorConfigFailureReason =
  /** The entry's backing store could not be read at all. */
  | 'unreadable'
  /** The entry's payload is not well-formed JSON. */
  | 'invalid-json'
  /** The entry's payload is well-formed JSON whose top-level value is not an object. */
  | 'not-an-object';

/** Fields shared by every {@link ExtensionOperatorConfigEntry} variant. */
interface ExtensionOperatorConfigEntryBase {
  /**
   * Opaque, human-readable label identifying where this entry came from.
   *
   * Reproduced verbatim in diagnostics so an operator can find and correct the
   * offending input. The consumer never parses or interprets it.
   */
  readonly source: string;
}

/** An operator-supplied configuration object for one extension. */
export interface ExtensionOperatorConfigValue extends ExtensionOperatorConfigEntryBase {
  /** Discriminant selecting the usable variant. */
  readonly kind: 'config';
  /**
   * The operator's configuration object for the extension.
   *
   * Applied as the highest-precedence layer of the extension's configuration
   * chain. It is not validated by the producer — the extension's own config
   * schema is the authority.
   *
   * Typed as JSON values because the layer merges one level deep: a key the
   * operator declares replaces the lower layers' value for that key. `undefined`
   * is not a JSON value and must never appear, or a key the operator never
   * meant to touch would be blanked out rather than overridden.
   */
  readonly config: Readonly<Record<string, JsonValue>>;
}

/** An operator-supplied configuration entry that could not be read or parsed. */
export interface ExtensionOperatorConfigFailure extends ExtensionOperatorConfigEntryBase {
  /** Discriminant selecting the failure variant. */
  readonly kind: 'failure';
  /** Category of the problem, used to phrase the diagnostic. */
  readonly reason: ExtensionOperatorConfigFailureReason;
  /**
   * Underlying error text, when the producer has one.
   *
   * Appended to the diagnostic raised when the affected extension activates,
   * which is logged and persisted as the extension's failure reason. Producers
   * supply a short explanation of why the entry could not be used — never the
   * entry's own content, which may be large or hold values an operator does not
   * expect to see echoed. The consumer flattens control characters and bounds
   * the length regardless.
   */
  readonly detail?: string;
}

/**
 * One operator-supplied configuration entry: either a usable configuration
 * object or a source-aware failure.
 */
export type ExtensionOperatorConfigEntry = ExtensionOperatorConfigValue | ExtensionOperatorConfigFailure;

/**
 * Abstract, operator-owned configuration layer keyed by extension name.
 *
 * Supplied by the host composition root and consulted at every extension
 * configuration-resolution point. It is the highest-precedence layer: its
 * values override both descriptor/host defaults and stored configuration
 * records, because an operator entry is an explicit, hand-authored decision
 * that a later write from another tier must not silently erase.
 *
 * The contract is deliberately free of storage vocabulary. A producer decides
 * where entries come from; the consumer only distinguishes "usable
 * configuration" from "unusable, and here is where it came from".
 *
 * Implementations are expected to be immutable for the lifetime of the
 * coordinator that consumes them, so an extension that is stopped and started
 * again resolves against the same values.
 */
export interface ExtensionOperatorConfigSource {
  /**
   * Look up the operator entry for one extension.
   *
   * **Must not throw, and must be stable.** For the lifetime of the coordinator
   * that holds the source, the same name must yield an equivalent entry — the
   * same variant, the same `source`, and the same configuration values. A
   * producer therefore captures its inputs once, up front, and answers every
   * later lookup from that immutable snapshot rather than re-reading them.
   *
   * Stability is what lets an extension be stopped and started again without
   * its configuration changing underneath it, and what lets read-only callers
   * resolve an already-active extension's context knowing the operator layer
   * cannot newly reject it.
   * @param extensionName - Extension package name to look up.
   * @returns The operator entry, or `undefined` when the operator supplied
   *   nothing for this extension.
   */
  get(extensionName: string): ExtensionOperatorConfigEntry | undefined;
}
