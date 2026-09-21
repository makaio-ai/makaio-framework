/**
 * Target-selection strategies for the gateway routing layer.
 *
 * A {@link TargetSelector} is created once per rule (at compile time via
 * {@link createTargetSelector}) and called for every matching request to pick
 * one {@link RouteTarget} from the rule's candidate list.
 *
 * Currently only the `static` strategy (always first candidate) is implemented.
 * Adding `round-robin` or another strategy requires only:
 * 1. A new `kind` union member in {@link StrategyConfig}.
 * 2. A new branch in {@link createTargetSelector}.
 * No other call sites change.
 * @packageDocumentation
 */

import type { StrategyConfig } from '../config.js';
import type { RouteTarget } from './types.js';

/**
 * Selects one target from a non-empty candidate list.
 *
 * Implementations must be stateless with respect to the list itself — state
 * that persists across calls (e.g. a round-robin index) is held in the
 * implementation object, not in arguments.
 */
export interface TargetSelector {
  /**
   * Pick one target from `candidates`.
   * @param candidates - Non-empty list of resolved targets for the matched rule.
   *   Always contains at least one element; callers guarantee this invariant.
   * @returns The selected target.
   */
  select(candidates: readonly RouteTarget[]): RouteTarget;
}

/**
 * Static-strategy implementation: always selects the first candidate.
 *
 * When `to` contains a single upstream name, this is equivalent to
 * unconditional selection. When multiple names are listed, the first is
 * permanently favoured regardless of request volume.
 */
const staticSelector: TargetSelector = {
  select(candidates: readonly RouteTarget[]): RouteTarget {
    // candidates is guaranteed non-empty by compileRules.
    return candidates[0];
  },
};

/**
 * Create a {@link TargetSelector} from a parsed strategy configuration.
 *
 * Called once per rule during {@link compileRules}. The returned selector is
 * reused for every matching request without re-allocation.
 * @param strategy - Parsed strategy configuration from the routing rule.
 * @returns A target selector implementing the requested strategy.
 */
export function createTargetSelector(strategy: StrategyConfig): TargetSelector {
  switch (strategy.kind) {
    case 'static':
      return staticSelector;
  }
}
