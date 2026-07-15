import { expect } from 'vitest';
import { z } from 'zod';

/**
 * Shorthand for asserting a parse succeeds and returning the typed value.
 * @param schema - The Zod schema to parse with.
 * @param value - The value to parse.
 * @returns The parsed value.
 */
export function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  const error = result.success ? undefined : result.error;
  expect(result.success, `expected parse to succeed: ${JSON.stringify(error)}`).toBe(true);
  if (!result.success) throw result.error;
  return result.data;
}

/**
 * Shorthand for asserting a parse fails.
 * @param schema - The Zod schema to parse with.
 * @param value - The value that should be rejected.
 */
export function rejected(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}
