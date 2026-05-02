import { InvalidArgumentError } from 'commander';

/**
 * Parse a CLI numeric value into a finite JavaScript number.
 * @param value - Raw Commander string value.
 * @returns Parsed finite number.
 * @throws InvalidArgumentError When the value is not numeric.
 */
export function parseNumericArg(value: string): number {
  if (value.trim() === '') {
    throw new InvalidArgumentError(`Expected a finite number, received '${value}'`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`Expected a finite number, received '${value}'`);
  }
  return parsed;
}
