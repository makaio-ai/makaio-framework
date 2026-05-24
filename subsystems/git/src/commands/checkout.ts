/**
 * Git checkout command.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { CheckoutResult, CheckoutOptions } from './types.js';

/**
 * Checkout a branch, tag, or commit.
 * @param git - SimpleGit instance
 * @param target - Branch, tag, or commit to checkout
 * @param options - Optional checkout configuration
 * @returns Checkout result with target info
 */
export async function checkoutRef(git: SimpleGit, target: string, options?: CheckoutOptions): Promise<CheckoutResult> {
  try {
    if (options?.createBranch) {
      const args = ['checkout', '-b', target];
      if (options.startPoint) {
        args.push(options.startPoint);
      }
      await git.raw(args);
      return { success: true, target, created: true };
    }

    await git.raw(['checkout', target]);
    return { success: true, target, created: false };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to checkout',
    };
  }
}
