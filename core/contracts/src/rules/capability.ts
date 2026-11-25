import type { RuleSourceTrigger } from './source.js';
import type { RuleValidationFinding, ValidateRulesInput } from './validation.js';

/**
 * Triggers of the kinds owned by the calling extension, with change
 * notification; the extension that owns a trigger kind derives its own
 * timers from this instead of asking the core over the bus.
 */
export interface RulesTriggerReader {
  /**
   * @returns The current triggers of the kinds this extension owns.
   */
  current(): RuleSourceTrigger[];
  /**
   * @param listener - Called after the filtered set of triggers changed.
   * @returns Unsubscribes `listener`; the extension's lifecycle also cleans
   *   up the subscription on unload.
   */
  onChange(listener: () => void): () => void;
}

/**
 * Capability of rules inside the host process, reached through the extension
 * context and never over the bus.
 */
export interface RulesCapability {
  /**
   * Pre-checks rule definitions as `makaio.rules` without a rights guarantee.
   * The runtime checks rights again at evaluation time, and that check is authoritative.
   * @param input - The rule set, groups and exclusions to check.
   * @returns Findings of the check; an empty array means nothing rejects the set.
   */
  validate(input: ValidateRulesInput): Promise<RuleValidationFinding[]>;

  /**
   * Triggers of the kinds this extension owns, from the rule set currently in effect.
   * @returns A reader of the current triggers with change notification.
   */
  triggers(): RulesTriggerReader;
}
