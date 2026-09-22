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
import { resolveInstalledExtensionRecord, type ExtensionRuntimeSurface } from '@makaio/kernel';
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
   *
   * Deliberately used verbatim, with no project-local tier mixed in. A
   * supplied discovery is the one `serve` boots with here, and with no
   * `discoveryPaths` declared that is the data home's two roots and nothing
   * else — so a descriptor found only in `{cwd}/node_modules` is one no server
   * started from this directory would load. Listing or toggling it would offer
   * a preference that never takes effect, which is the report this listing
   * exists to stop producing. Making that tier visible is a boot decision, not
   * a listing one: a host that wants it declares
   * `extensions.discoveryPaths: ['node_modules']`, or hands `serve` no
   * discovery at all, and this listing follows either way.
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
  /**
   * Runtime surface the server this host would start boots with.
   *
   * Decides which of two same-named copies restricted to different surfaces an
   * offline toggle answers for — the coordinator filters by surface before it
   * resolves names, so only one of them is the copy that next start loads. The
   * host that owns `serve`'s boot overrides is the only place this is known,
   * which is why it is passed in rather than assumed: a desktop host whose
   * `serve` boots interactive must not have its extensions judged against the
   * headless copy.
   *
   * Defaults to `'headless'`, the same default `serve` applies when its host
   * declares none.
   */
  readonly surface?: ExtensionRuntimeSurface;
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
 * Surface a server started from this machine boots with when its host declares
 * none — the same default `serve` applies.
 */
const DEFAULT_OFFLINE_SURFACE: ExtensionRuntimeSurface = 'headless';

/**
 * Resolve the installed record an offline toggle must validate a name against.
 *
 * Delegates to the coordinator's own resolution so a name claimed by several
 * installed copies is decided identically whether a server answered or this
 * process did: shadowed copies lose to live ones, the surface the next boot
 * runs on decides between same-name copies restricted to different surfaces,
 * and the contest is judged against the copies that surface actually loads.
 * Callers read {@link InstalledExtensionRecord.collidesWith} on the result to
 * refuse a name no boot resolves.
 * @param installed - Installed-package listing from {@link listInstalledExtensions}.
 * @param name - Extension package name being addressed.
 * @param options - Host capabilities for this invocation; its
 *   {@link InstalledExtensionListingOptions.surface} is what the answer is
 *   resolved for.
 * @returns The record to validate against, or `undefined` when nothing
 *   installed here claims the name.
 */
export function resolveInstalledEntry(
  installed: readonly InstalledExtensionRecord[],
  name: string,
  options: InstalledExtensionListingOptions = {},
): InstalledExtensionRecord | undefined {
  return resolveInstalledExtensionRecord(installed, name, options.surface ?? DEFAULT_OFFLINE_SURFACE);
}
