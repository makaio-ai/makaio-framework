import { expect } from 'vitest';
import { SubagentConfigSchema, SubagentError, type SubagentConfig } from '@makaio/contracts';

/**
 * Create a subagent config with schema defaults applied.
 * @param task - Task description.
 * @returns Parsed subagent config.
 */
export function config(task: string): SubagentConfig {
  return SubagentConfigSchema.parse({ task });
}

/**
 * Verify a synchronous call throws a SubagentError with the expected code.
 * @param fn - Function expected to throw.
 * @param expectedCode - Expected subagent error code.
 */
export function expectSubagentError(fn: () => void, expectedCode: string): void {
  try {
    fn();
    expect.fail('Expected function to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(SubagentError);
    expect((err as SubagentError).code).toBe(expectedCode);
  }
}
