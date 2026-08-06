import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { AutomationCronSchedulerToken } from './cron-scheduler.js';
import { localAutomationCronSchedulerPackage } from './local-cron-scheduler.js';

/** Minimal package view needed to detect an already-present provider. */
interface CronSchedulerProviderView {
  /** Package name; a provider registers under the scheduler token name. */
  readonly name: string;
  /** Human-readable name used in duplicate-provider diagnostics. */
  readonly displayName?: string;
}

/** Inputs of one host's cron scheduler provider decision. */
export interface AutomationCronSchedulerSelection {
  /**
   * Provider packages explicitly contributed by host composition seams, if any.
   *
   * Must register under {@link AutomationCronSchedulerToken}; a package that
   * does not is a wiring mistake and fails boot rather than silently leaving the
   * runtime without a scheduler.
   *
   * More than one entry is a composition error. The array form lets boot combine
   * its direct host option with descriptor server-module host exports before
   * making one deterministic provider decision.
   */
  readonly hostPackages?: readonly MakaioNodeExtension<IMakaioBus>[] | undefined;
  /**
   * Every package the host is about to load, framework and extension alike.
   *
   * Scanned for provider registrations so a second provider is rejected before
   * the coordinator starts either of them.
   */
  readonly loadedPackages: readonly CronSchedulerProviderView[];
}

/**
 * Decides which cron scheduler provider package a host must add.
 *
 * Exactly one provider is active in a booted runtime:
 *
 * - A host that supplies one provider package uses it, and no loaded package may also
 *   register the service.
 * - A host that supplies none uses the loaded provider when there is exactly
 *   one, and otherwise falls back to the framework's local provider — that
 *   fallback is what makes framework-only boot work with no host wiring.
 * - Two providers, or a host package that does not register the service, fail
 *   boot with a message naming the offenders.
 * @param selection - The host's explicit choice plus the packages being loaded.
 * @returns The provider package to add, or `undefined` when a loaded package
 *   already provides one.
 * @throws When a host package does not register the scheduler service, or when
 *   more than one provider would be active.
 */
export function selectAutomationCronSchedulerPackage(
  selection: AutomationCronSchedulerSelection,
): MakaioNodeExtension<IMakaioBus> | undefined {
  const tokenName = AutomationCronSchedulerToken.name;
  const providers = selection.loadedPackages.filter((pkg) => pkg.name === tokenName);

  const hostPackages = selection.hostPackages ?? [];
  for (const hostPackage of hostPackages) {
    if (hostPackage.name !== tokenName) {
      throw new Error(
        `Automation cron scheduler package '${hostPackage.name}' does not register the cron scheduler service; it must be named '${tokenName}'.`,
      );
    }
  }

  if (hostPackages.length > 1) {
    throw new Error(
      `Multiple automation cron scheduler providers: host packages ${describeProviders(hostPackages)}. Exactly one provider may register '${tokenName}'.`,
    );
  }

  const hostPackage = hostPackages[0];
  if (hostPackage) {
    if (providers.length > 0) {
      throw new Error(
        `Multiple automation cron scheduler providers: host package '${describeProvider(hostPackage)}' and loaded ${describeProviders(providers)}. Exactly one provider may register '${tokenName}'.`,
      );
    }
    return hostPackage;
  }

  if (providers.length > 1) {
    throw new Error(
      `Multiple automation cron scheduler providers: ${describeProviders(providers)}. Exactly one provider may register '${tokenName}'.`,
    );
  }

  return providers.length === 1 ? undefined : localAutomationCronSchedulerPackage;
}

/**
 * Describes one provider for a diagnostic message.
 *
 * Providers all share the token name, so the display name is what distinguishes
 * them in the error.
 * @param provider - Provider package view.
 * @returns Display name when present, otherwise the package name.
 */
function describeProvider(provider: CronSchedulerProviderView): string {
  return provider.displayName ?? provider.name;
}

/**
 * Describes a provider list for a diagnostic message.
 * @param providers - Provider package views.
 * @returns Comma-separated, quoted provider descriptions.
 */
function describeProviders(providers: readonly CronSchedulerProviderView[]): string {
  return providers.map((provider) => `'${describeProvider(provider)}'`).join(', ');
}
