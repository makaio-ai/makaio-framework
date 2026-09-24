import { expect } from 'vitest';
import { z } from 'zod';
import type { ArtifactViewModel } from '../view-model.js';

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

// This fixture is duplicated on purpose rather than shared: a package cannot
// import another package's `__tests__` code, and consumer packages (such as the
// GitHub extension) keep their own copy for their own tests.
/**
 * Build a minimal artifact view model with optional overrides.
 * @param overrides - Properties to merge onto the base view model.
 * @returns A complete artifact view model fixture.
 */
export function makeView(overrides: Partial<ArtifactViewModel> = {}): ArtifactViewModel {
  return {
    title: 'Test Artifact',
    artifact: { id: 'artifact-test-001', kind: 'test-kind', revision: 'rev-1' },
    navigation: { breadcrumbs: [], related: [] },
    sections: [],
    links: {},
    ...overrides,
  };
}
