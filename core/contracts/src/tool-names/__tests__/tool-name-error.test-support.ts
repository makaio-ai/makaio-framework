import { expect } from 'vitest';
import { ToolNameError } from '../index.js';

/**
 * Runs `fn` and returns the thrown ToolNameError, failing the test if nothing
 * (or something else) is thrown.
 * @param fn - Callback expected to throw a ToolNameError
 * @returns The thrown ToolNameError
 */
export function captureToolNameError(fn: () => unknown): ToolNameError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolNameError);
    return error as ToolNameError;
  }
  throw new Error('expected a ToolNameError to be thrown');
}
