/**
 * This machine's own installed-extension listing, used by the offline paths of
 * `extension list`, `extension enable`, and `extension disable`.
 *
 * Only ever the fallback for "no server to ask": a reachable server owns the
 * answer for its own host and reports it through `kernel:extension.catalog`,
 * which covers tiers this process cannot see at all (another machine's
 * installs, or a project-local tier under a working directory that is not this
 * one). This listing is correct precisely when no server is reachable, because
 * then this process is the only view there is — and a server started here
 * later would read the same tiers.
 * @packageDocumentation
 */
import {
  buildConfiguredRuntimeOptions,
  FilesystemDescriptorDiscovery,
  MergedDescriptorDiscovery,
  scanInstalledExtensions,
  type ExtensionDiscovery,
  type FrameworkModuleResolver,
  type InstalledExtensionRecord,
} from '@makaio/runtime-node';

export type { InstalledExtensionRecord };

/** Host capabilities the offline listing needs to read the same declarations a booted runtime would. */
export interface InstalledExtensionListingOptions {
  /**
   * The discovery strategy this invocation resolved from runtime config — the
   * one `makaio serve` would boot with.
   *
   * Supplying it is what keeps the offline answer equal to the answer a local
   * server would give: a host that configures its own descriptor roots or
   * filters must not have its extensions declared not-installed just because
   * no server happened to be running.
   *
   * Absent only when a host assembled the command tree without resolving
   * runtime config (the CLI's own entrypoint always resolves it first). The
   * listing then reconstructs the discovery such a host's `serve` would boot
   * with — see {@link buildUnconfiguredDiscovery} — never a separate hardcoded
   * tier list.
   */
  readonly discovery?: ExtensionDiscovery;
  /**
   * Module resolver for `@makaio/framework/*` subpath imports, as selected by
   * the host that owns this invocation.
   *
   * The offline listing imports each descriptor's server entrypoint on this
   * process's own module registry, so an extension installed from a local path
   * — which lives outside this process's module tree — only resolves its
   * framework imports while the host's resolver hook is installed. Without it,
   * such an extension's criticality is reported unknown, which fails closed
   * and refuses a disable the runtime itself would have allowed. Omitted by
   * hosts that resolve `@makaio/framework/*` natively.
   */
  readonly frameworkModuleResolver?: FrameworkModuleResolver;
}

/**
 * List every extension package this machine's configured discovery can see,
 * expanded with the executable child packages each descriptor exports.
 *
 * Scans exactly what a runtime started from this directory would discover:
 * with no server reachable, this process's working directory is the only one
 * any answer could be relative to.
 * @param makaioHome - Resolved Makaio data home, used to locate the runtime
 *   config when the caller did not resolve a discovery itself.
 * @param options - Host capabilities for this listing.
 * @returns One record per executable package name, in discovery-tier priority
 *   order.
 */
export async function listInstalledExtensions(
  makaioHome: string,
  options: InstalledExtensionListingOptions = {},
): Promise<readonly InstalledExtensionRecord[]> {
  const discovery = options.discovery ?? (await buildUnconfiguredDiscovery(makaioHome));
  return scanInstalledExtensions({
    discovery,
    ...(options.frameworkModuleResolver && { frameworkModuleResolver: options.frameworkModuleResolver }),
  });
}

/**
 * Rebuild the discovery a `serve` started by this same unconfigured host would
 * boot with.
 *
 * A host that did not resolve runtime config also hands `serve` no boot
 * discovery, so the runtime falls back to its own filesystem default, whose
 * highest-priority tier is this process's `{cwd}/node_modules`. Runtime config
 * defaults cover only the data home's roots, so asking for it alone would
 * declare a project's own dependency not-installed — refusing a toggle for a
 * package the very next `makaio serve` in this directory loads. The
 * project-local tier therefore leads, ahead of whatever the config resolves,
 * exactly as it does in that default.
 * @param makaioHome - Resolved Makaio data home used to locate runtime config.
 * @returns The project-local tier merged ahead of the configured roots.
 */
async function buildUnconfiguredDiscovery(makaioHome: string): Promise<ExtensionDiscovery> {
  const configured = (await buildConfiguredRuntimeOptions({ makaioHome })).discovery;
  // With no directory options, this discovery scans the project-local tier and
  // nothing else — the data-home tiers are the configured discovery's to
  // report, under whatever roots and filters a config file declares.
  return new MergedDescriptorDiscovery([new FilesystemDescriptorDiscovery(), configured]);
}

/**
 * Find the installed record that reports a name as unresolvably claimed.
 *
 * Shared by the toggle commands so an enablement preference is never persisted
 * for a name no boot will resolve — see
 * {@link InstalledExtensionRecord.collidesWith}. Scanning for any colliding row
 * rather than the first row matching the name matters because every claimant
 * carries the marker, and the first one is not a winner.
 * @param installed - Installed-package listing from {@link listInstalledExtensions}.
 * @param name - Extension package name being addressed.
 * @returns The first colliding record claiming `name`, or `undefined` when the
 *   name is unambiguous.
 */
export function findCollidingInstalledEntry(
  installed: readonly InstalledExtensionRecord[],
  name: string,
): InstalledExtensionRecord | undefined {
  return installed.find((ext) => ext.name === name && ext.collidesWith !== undefined);
}
