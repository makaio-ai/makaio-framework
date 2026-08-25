/**
 * Validate a numeric composition option as a finite number.
 * @param label - Option name reported in the failure message.
 * @param value - Configured value to validate.
 * @returns The validated value.
 * @throws {@link Error} When the value is not a finite number.
 */
export function requireFiniteOption(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Option "${label}" must be a finite number, received ${value}.`);
  }
  return value;
}

/**
 * Validate a composition option that names something, as a non-empty string.
 *
 * Identity is not merely cosmetic here: the selector reads a provider's `id` and
 * refuses a registration whose declared fields are unusable, so a provider
 * composed with an empty one constructs successfully, registers successfully,
 * and is then rejected by every selection pass — reported as `invalid_provider`
 * for requests that named no provider at all. A composition error must surface
 * where the provider is assembled, exactly as the numeric options do.
 * @param label - Option name reported in the failure message.
 * @param value - Configured value to validate.
 * @param maxLength - Optional inclusive character limit for addressable identifiers.
 * @returns The validated value.
 * @throws {@link Error} When the value is empty or only whitespace.
 */
export function requireNamedOption(label: string, value: string, maxLength?: number): string {
  if (value.trim().length === 0) {
    throw new Error(`Option "${label}" must be a non-empty string.`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new Error(`Option "${label}" must contain at most ${maxLength} characters.`);
  }
  return value;
}

/**
 * Validate a numeric composition option as an integer within range.
 * @param label - Option name reported in the failure message.
 * @param value - Configured value to validate.
 * @param minimum - Smallest value the option accepts.
 * @returns The validated value.
 * @throws {@link Error} When the value is not an integer at or above `minimum`.
 */
export function requireIntegerOption(label: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`Option "${label}" must be an integer of at least ${minimum}, received ${value}.`);
  }
  return value;
}
