import {
  buildExtensionContext,
  extensionGenerationSignal,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
import type { ContributionProcessor, ExtensionEntry, KernelHostContext } from './types.js';

/**
 * Invoke all registered {@link ContributionProcessor} instances for one extension.
 *
 * For `'activated'` actions, processors that declare a {@link ContributionProcessor.filter}
 * are pre-screened; only matching processors have their
 * {@link ContributionProcessor.processActivated} called.
 *
 * Before service initialization, every processor with a pre-activation hook
 * can stage static manifest contributions. A failure rolls back processors
 * that started staging or completed activation, once each in reverse order.
 *
 * For `'stopped'` actions, the rule source is released before withdrawing other
 * contributions. Every processor that implements
 * {@link ContributionProcessor.processStopped} is called regardless of its filter,
 * because teardown must be symmetric — if an extension passed the filter at
 * activation time that state is now gone, and a processor that registered
 * side-effects must still clean them up. Stopped processors run in reverse
 * registration order so teardown mirrors activation. Every stopped processor
 * runs even when one fails; their errors are returned to the lifecycle owner
 * so it can finish cleanup and report the incomplete teardown.
 * @param processors - Registration-ordered list of processors to invoke.
 * @param contextHost - Coordinator surface used to build per-extension contexts.
 * @param name - Extension name used in log messages.
 * @param entry - Extension entry for context resolution.
 * @param action - Whether the extension just became active or was stopped.
 * @param initialize - Optional service initialization between contribution phases.
 * @returns Collected teardown failures for `stopped`; an empty array for `activated`.
 */
export async function runContributionProcessors<THostContext extends KernelHostContext>(
  processors: ReadonlyArray<ContributionProcessor<THostContext>>,
  contextHost: ExtensionContextHost<THostContext>,
  name: string,
  entry: ExtensionEntry<THostContext>,
  action: 'activated' | 'stopped',
  initialize?: () => Promise<void>,
): Promise<unknown[]> {
  if (action === 'activated') {
    await activateContributions(processors, contextHost, name, entry, initialize);
    return [];
  }

  contextHost.rules.release(extensionGenerationSignal(entry.identity));
  return runStoppedProcessors(processors, name, contextHost.rights, 'stop');
}

/**
 * Stage contributions, initialize the service, and run activation processors.
 * Staging can be rolled back even if its hook throws. An activation hook
 * still owns its own partial activation work when it throws.
 * @param processors - Registration-ordered list of processors to invoke.
 * @param contextHost - Coordinator surface used to build per-extension contexts.
 * @param name - Extension name used in log messages.
 * @param entry - Extension entry for context resolution.
 * @param initialize - Optional service initialization between contribution phases.
 */
async function activateContributions<THostContext extends KernelHostContext>(
  processors: ReadonlyArray<ContributionProcessor<THostContext>>,
  contextHost: ExtensionContextHost<THostContext>,
  name: string,
  entry: ExtensionEntry<THostContext>,
  initialize?: () => Promise<void>,
): Promise<void> {
  const rollback = new Set<ContributionProcessor<THostContext>>();
  const generation = extensionGenerationSignal(entry.identity);
  let sourceLease: { release(): void } | undefined;

  try {
    for (const processor of processors) {
      if (!processor.processActivating) continue;
      rollback.add(processor);
      await processor.processActivating(name, entry.pkg);
    }

    if (initialize) await initialize();

    for (const processor of processors) {
      if (processor.filter && !processor.filter(entry.pkg)) continue;
      const config = resolveExtensionEntryConfig(contextHost, name, entry, 'activate');
      const pkgCtx = buildExtensionContext(contextHost, entry, config);
      await processor.processActivated(name, entry.pkg, pkgCtx);
      rollback.delete(processor);
      rollback.add(processor);
    }
    if (entry.pkg.ruleSource) {
      sourceLease = contextHost.rules.register(name, entry.pkg.ruleSource, generation);
    }
    if (contextHost.rights.activate(name, entry.pkg)) {
      console.warn(`[ExtensionCoordinator] Rights contributions from "${name}" require a host process.`);
    }
  } catch (err) {
    sourceLease?.release();
    const failures = await runStoppedProcessors([...rollback], name, contextHost.rights, 'activation-rollback');
    for (const failure of failures) {
      console.error(`[ExtensionCoordinator] Contribution processor rollback error for "${name}":`, failure);
    }
    throw err;
  }
}

/**
 * Run contribution processors for a stopped extension.
 *
 * Processors run in reverse registration order so teardown mirrors activation.
 * Errors are collected while subsequent processors continue to run.
 * @param processors - Registration-ordered list of processors to invoke.
 * @param name - Extension name used in log messages.
 * @param rights - The coordinator's rights lifecycle.
 * @param reason - Whether to stop a completed activation or roll back a failed one.
 * @returns Failures raised by rights release and stopped processors, in invocation order.
 */
async function runStoppedProcessors(
  processors: ReadonlyArray<Pick<ContributionProcessor, 'processStopped' | 'processActivationRollback'>>,
  name: string,
  rights: Pick<ExtensionContextHost['rights'], 'deactivate'>,
  reason: 'stop' | 'activation-rollback',
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    rights.deactivate(name);
  } catch (error) {
    failures.push(error);
  }

  for (const processor of [...processors].reverse()) {
    try {
      if (reason === 'activation-rollback' && processor.processActivationRollback) {
        await processor.processActivationRollback(name);
      } else if (processor.processStopped) {
        await processor.processStopped(name);
      }
    } catch (err) {
      failures.push(err);
    }
  }

  return failures;
}
