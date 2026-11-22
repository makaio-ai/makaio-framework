/**
 * Runtime brand of a secret.
 *
 * Registered in the global symbol registry so that every loaded copy of this
 * module (bundles may each carry one) recognizes the secrets of the others.
 */
const secretBrand: unique symbol = Symbol.for('@makaio/contracts.Secret');

/** Fixed text every string conversion of a secret yields instead of its value. */
const SECRET_PLACEHOLDER = '[Secret]';

/**
 * A credential held in memory.
 *
 * The value is reachable only through {@link Secret.reveal}. JSON
 * serialization throws and string conversion yields a fixed placeholder, so
 * the value cannot leak through logging or accidental serialization.
 */
export interface Secret {
  /** Runtime brand set by {@link createSecret}. */
  readonly [secretBrand]: true;

  /**
   * Returns the plaintext value.
   * @returns The plaintext credential.
   */
  reveal(): string;

  /**
   * Refuses JSON serialization.
   * @returns Never returns.
   * @throws A `TypeError` whose message does not contain the value.
   */
  toJSON(): never;
}

/**
 * Creates a secret without exposing its value as an object property.
 *
 * The value lives in a closure. The returned object is frozen, and its
 * non-enumerable `toString` yields a fixed placeholder.
 * @param value - Plaintext credential.
 * @returns The branded secret.
 */
export function createSecret(value: string): Secret {
  const secret: Secret = {
    [secretBrand]: true,
    reveal: () => value,
    toJSON(): never {
      throw new TypeError('Secret cannot be serialized');
    },
  };
  Object.defineProperty(secret, 'toString', {
    value: (): string => SECRET_PLACEHOLDER,
    enumerable: false,
  });
  return Object.freeze(secret);
}

/**
 * Checks whether a value has the shape of a secret: the brand and both
 * methods of the contract.
 *
 * The brand lives in the global symbol registry, so the check recognizes
 * secrets of every loaded copy of this module. It is a shape check, not proof
 * of origin: code in the same process can build such an object by hand.
 * @param value - Value to inspect.
 * @returns `true` when the value is usable as a {@link Secret}.
 */
export function isSecret(value: unknown): value is Secret {
  if (typeof value !== 'object' || value === null || !(secretBrand in value)) return false;
  return (
    value[secretBrand] === true &&
    'reveal' in value &&
    typeof value.reveal === 'function' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  );
}
