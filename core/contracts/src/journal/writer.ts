import type { JsonSchema, JsonValue } from '../shared/json-value.js';
import type { Secret } from '../credential/secret.js';
import type { ExternalObjectRef } from './external-object-ref.js';
import type { IntentId, WriterName } from './write-identifiers.js';
import type { CreateTarget, WriteTarget } from './write-schemas.js';

/**
 * Input of {@link WriterContribution.write}: the fields common to both modes
 * plus either a create target or an existing object.
 */
export type WriterInput = {
  /** The content to write. */
  readonly content: JsonValue;
  /** Identifier of the write intent, stable across retries. */
  readonly intentId: IntentId;
  /** The resolved credential for the write. */
  readonly credential: Secret;
  /** Point in time by which the writer must have finished. */
  readonly deadline: string;
} & (
  | {
      /** Create a new external object. */
      readonly mode: 'create';
      /** Where to create the object. */
      readonly create: CreateTarget;
    }
  | {
      /** Update an existing external object. */
      readonly mode: 'update';
      /** The object to update. */
      readonly object: ExternalObjectRef;
    }
);

/**
 * Outcome of {@link WriterContribution.write}: exactly one of `written`,
 * `notWritten` or `unknown`.
 */
export type WriterOutcome =
  | {
      /** The write took effect on this object. */
      readonly written: ExternalObjectRef;
      readonly notWritten?: never;
      readonly unknown?: never;
    }
  | {
      readonly written?: never;
      /** The write was refused definitively. */
      readonly notWritten: {
        /** Machine-readable refusal code. */
        readonly code: string;
        /** Why the write was refused. */
        readonly reason: string;
        /** Whether the same write may be retried. */
        readonly retryable: boolean;
      };
      readonly unknown?: never;
    }
  | {
      readonly written?: never;
      readonly notWritten?: never;
      /** It is not known whether the write took effect; the text says why. */
      readonly unknown: string;
    };

/**
 * Input of {@link WriterContribution.findExisting}.
 */
export type FindExistingInput = {
  /** Identifier of the write intent to look for. */
  readonly intentId: IntentId;
  /** The target of the write. */
  readonly target: WriteTarget;
  /** The content of the write. */
  readonly content: JsonValue;
  /** The resolved credential for the lookup. */
  readonly credential: Secret;
  /** Point in time by which the lookup must have finished. */
  readonly deadline: string;
};

/**
 * Outcome of {@link WriterContribution.findExisting}: exactly one of `found`,
 * `absent` or `undecidable`.
 */
export type FindExistingOutcome =
  | {
      /** The write of the intent took effect on this object. */
      readonly found: ExternalObjectRef;
      readonly absent?: never;
      readonly undecidable?: never;
    }
  | {
      readonly found?: never;
      /** The write of the intent is certainly not present. */
      readonly absent: true;
      readonly undecidable?: never;
    }
  | {
      readonly found?: never;
      readonly absent?: never;
      /** The lookup cannot decide; the text says why. */
      readonly undecidable: string;
    };

/**
 * Contribution of a writer: the code that writes content to one kind of
 * external object. Its callbacks take no call context.
 */
export interface WriterContribution {
  /** Name of the writer. */
  readonly writer: WriterName;
  /** Human-readable description of the writer. */
  readonly description: string;
  /** The object types this writer can write. */
  readonly objectTypes: readonly string[];
  /** JSON Schema of the content this writer accepts. */
  readonly contentSchema: JsonSchema;

  /**
   * Writes the content to the external object.
   * @param input - The content, the intent, the credential, the deadline and the mode.
   * @returns What came of the write.
   */
  write(input: WriterInput): Promise<WriterOutcome>;

  /**
   * Looks for an earlier write of the same intent.
   * @param input - The intent, the target, the content, the credential and the deadline.
   * @returns Whether the earlier write was found, is absent, or cannot be decided.
   */
  findExisting(input: FindExistingInput): Promise<FindExistingOutcome>;
}
