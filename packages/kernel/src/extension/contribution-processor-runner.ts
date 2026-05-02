import {
  buildExtensionContext,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

/**
 * Invoke all registered {@link ContributionProcessor} instances for one extension.
 *
 * For `'activated'` actions, processors that declare a {@link ContributionProcessor.filter}
 * are pre-screened; only matching processors have their
 * {@link ContributionProcessor.processActivated} called.
 *
 * **Error semantics (Q2 decision):** Contribution activation is part of extension
 * activation. Hard failures (thrown errors) propagate to the caller so the
 * coordinator can rollback already-activated contributions, destroy the service,
 * and transition the extension to `failed`. Processors are responsible for
 * internal rollback of their own partial state before re-throwing.
 *
 * For `'stopped'` actions, every processor that implements
 * {@link ContributionProcessor.processStopped} is called regardless of its filter,
 * because teardown must be symmetric — if an extension passed the filter at
 * activation time that state is now gone, and a processor that registered
 * side-effects must still clean them up. Stopped processors run in reverse
 * registration order so teardown mirrors activation. Errors during stopped
 * processing are logged but never thrown — shutdown must not be blocked.
 * @param processors - Registration-ordered list of processors to invoke.
 * @param contextHost - Coordinator surface used to build per-extension contexts.
 * @param name - Extension name used in log messages.
 * @param entry - Extension entry for context resolution.
 * @param action - Whether the extension just became active or was stopped.
 */
export async function runContributionProcessors(
  processors: ReadonlyArray<ContributionProcessor>,
  contextHost: ExtensionContextHost,
  name: string,
  entry: ExtensionEntry,
  action: 'activated' | 'stopped',
): Promise<void> {
  if (action === 'activated') {
    await runActivatedProcessors(processors, contextHost, name, entry);
  } else {
    await runStoppedProcessors(processors, name);
  }
}

/**
 * Run contribution processors for an activated extension.
 *
 * Processors run in registration order. If a processor throws, all
 * previously-invoked processors for this extension are torn down (via
 * {@link ContributionProcessor.processStopped}) in reverse order before
 * the error is re-thrown. This provides symmetric cleanup — a processor
 * that registered side-effects during `processActivated` gets a chance
 * to undo them even if a later processor fails.
 * @param processors - Registration-ordered list of processors to invoke.
 * @param contextHost - Coordinator surface used to build per-extension contexts.
 * @param name - Extension name used in log messages.
 * @param entry - Extension entry for context resolution.
 */
async function runActivatedProcessors(
  processors: ReadonlyArray<ContributionProcessor>,
  contextHost: ExtensionContextHost,
  name: string,
  entry: ExtensionEntry,
): Promise<void> {
  const activated: ContributionProcessor[] = [];

  try {
    for (const processor of processors) {
      if (processor.filter && !processor.filter(entry.pkg)) continue;
      const config = resolveExtensionEntryConfig(contextHost, name, entry);
      const pkgCtx = buildExtensionContext(contextHost, entry, config);
      await processor.processActivated(name, entry.pkg, pkgCtx);
      activated.push(processor);
    }
  } catch (err) {
    // Rollback already-activated processors in reverse order (best-effort).
    for (const processor of activated.reverse()) {
      if (!processor.processStopped) continue;
      try {
        await processor.processStopped(name);
      } catch (rollbackErr) {
        console.error(`[ExtensionCoordinator] Contribution processor rollback error for "${name}":`, rollbackErr);
      }
    }
    throw err;
  }
}

/**
 * Run contribution processors for a stopped extension (best-effort).
 *
 * Processors run in reverse registration order so teardown mirrors activation.
 * Errors are caught and logged — shutdown must not be blocked.
 * @param processors - Registration-ordered list of processors to invoke.
 * @param name - Extension name used in log messages.
 */
async function runStoppedProcessors(processors: ReadonlyArray<ContributionProcessor>, name: string): Promise<void> {
  for (const processor of [...processors].reverse()) {
    if (!processor.processStopped) continue;
    try {
      await processor.processStopped(name);
    } catch (err) {
      console.error(`[ExtensionCoordinator] Contribution processor error (stopped) for "${name}":`, err);
    }
  }
}
