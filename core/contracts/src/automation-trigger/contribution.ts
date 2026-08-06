import type { ExtensionContext, NodeExtensionContext } from '../extension/extension-context.js';
import type { AutomationTriggerType } from './definition.js';

/**
 * Executable automation trigger contribution surface declared by an extension.
 *
 * The runtime calls `createAutomationTriggers(ctx)` during extension activation
 * and registers the returned {@link AutomationTriggerType}s with the trigger
 * registry. The registry enforces that each trigger's `kind` is prefixed with
 * the contributing extension's name.
 *
 * Trigger definitions carry live Zod parameter and event schemas and a trusted
 * `activate` factory — they are runtime values and must never be included in
 * serializable descriptor metadata. Use {@link createAutomationTriggerDescriptor}
 * to produce the serializable representation for Builder discovery.
 * @typeParam THostContext - Concrete context shape supplied by the host runtime.
 *   Defaults to {@link NodeExtensionContext} because the current framework hosts
 *   are Node-based.
 */
export interface ExtensionAutomationTriggersContribution<THostContext extends ExtensionContext = NodeExtensionContext> {
  /**
   * Factory that produces the automation trigger definitions for this extension.
   *
   * Called during extension activation. The returned list is the extension's
   * complete trigger batch and atomically replaces any prior batch registered
   * under this extension's name. Returning a `Promise` allows async resource
   * acquisition (e.g. lazy loading or config resolution).
   * @param context - Per-extension runtime context supplied by the host.
   * @returns Trigger definitions or a promise that resolves to them.
   */
  readonly createAutomationTriggers: (
    context: THostContext,
  ) => readonly AutomationTriggerType[] | Promise<readonly AutomationTriggerType[]>;
}
