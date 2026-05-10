import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { type ExtensionDescriptor, parseExtensionDescriptor, type MakaioExtension } from '@makaio/contracts';

/** Preloaded server entry module used by bundled hosts. */
export interface ExtensionEntrypointModule {
  /** Server entry default export. */
  readonly default: MakaioExtension | ReadonlyArray<MakaioExtension>;
}

/**
 * An extension discovered on the filesystem.
 * Carries the validated descriptor and the absolute path to the extension
 * package root (used to resolve {@link ExtensionDescriptor.entrypoints}).
 */
export interface DiscoveredExtension {
  /** Validated descriptor parsed from `descriptor.json`. */
  readonly descriptor: ExtensionDescriptor;
  /** Absolute path to the extension package root directory. */
  readonly extensionPath: string;
  /**
   * Where the extension was found.
   * `'local'` (project node_modules) takes priority over `'installed'` (managed extensions),
   * which takes priority over `'global-npm'` (global npm install).
   */
  readonly source: 'local' | 'installed' | 'global-npm';
  /**
   * Pre-loaded server entry module. When present, the extension loader skips
   * filesystem-based entry resolution and uses this module directly. Enables
   * bundled deployments where extension code is statically imported at build
   * time rather than dynamically discovered on disk.
   */
  readonly preloadedModule?: ExtensionEntrypointModule;
}

/**
 * Options for {@link FilesystemDescriptorDiscovery}.
 */
export interface FilesystemDescriptorDiscoveryOptions {
  /**
   * Override for project-local extension packages, or `false` to skip the
   * local tier. Defaults to `{cwd}/node_modules`.
   */
  readonly localNodeModulesDir?: string | false;
  /**
   * Managed extension install directory (e.g. `{makaioHome}/extensions`).
   */
  readonly extensionsDir: string;
  /**
   * Global npm node_modules directory (e.g. `{makaioHome}/node_modules`).
   */
  readonly nodeModulesDir: string;
}

/**
 * Strategy interface for discovering extensions.
 * Implementations scan different locations (filesystem, explicit list)
 * and return validated descriptors ready for the loading bridge.
 */
export interface ExtensionDiscovery {
  /** Scan for extensions and return validated discoveries. */
  discover(): Promise<DiscoveredExtension[]>;
}

/**
 * Discovers extensions by scanning up to three locations in priority order:
 *
 * 1. `{cwd}/node_modules/` — project-local installs (`'local'`), unless disabled via options
 * 2. `{makaioHome}/extensions/` — managed extension installs (`'installed'`), requires `options.extensionsDir`
 * 3. `{makaioHome}/node_modules/` — global npm installs (`'global-npm'`), requires `options.nodeModulesDir`
 *
 * When `options` is omitted, only the local tier is scanned (installed/global tiers are skipped).
 * Each location supports both flat (`pkg/`) and scoped (`@scope/pkg/`) packages.
 * Validates each descriptor against {@link ExtensionDescriptorSchema}.
 * Malformed or invalid descriptors are skipped with a console warning.
 * On name collision, earlier tiers win (local \> installed \> global-npm).
 */
export class FilesystemDescriptorDiscovery implements ExtensionDiscovery {
  private readonly localNodeModulesDir: string | false;
  private readonly extensionsDir: string | false;
  private readonly nodeModulesDir: string | false;

  /**
   * @param cwd - Working directory for local node_modules scan. Defaults to `process.cwd()`.
   * @param options - Discovery directory configuration. When omitted, only project-local
   *   node_modules are scanned (installed/global tiers are skipped). When provided, both
   *   `extensionsDir` and `nodeModulesDir` are required so callers cannot silently
   *   fall back to a hardcoded default.
   */
  public constructor(cwd?: string, options?: FilesystemDescriptorDiscoveryOptions) {
    this.localNodeModulesDir = options?.localNodeModulesDir ?? path.join(cwd ?? process.cwd(), 'node_modules');
    this.extensionsDir = options?.extensionsDir ?? false;
    this.nodeModulesDir = options?.nodeModulesDir ?? false;
  }

  /**
   * Scan all three extension locations and return a deduplicated list.
   *
   * Priority: local → installed → global-npm. Earlier tiers win on name collision.
   * @returns Deduplicated list of discovered extensions ordered by priority.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const [local, installed, globalNpm] = await Promise.all([
      this.scanLocal(),
      this.scanInstalled(),
      this.scanGlobalNpm(),
    ]);
    return this.deduplicate(local, installed, globalNpm);
  }

  /**
   * Scan project-local node_modules for descriptor.json files.
   * @returns Discovered extensions from node_modules.
   */
  private async scanLocal(): Promise<DiscoveredExtension[]> {
    if (this.localNodeModulesDir === false) {
      return [];
    }
    const patterns = [
      path.join(this.localNodeModulesDir, '*/descriptor.json'),
      path.join(this.localNodeModulesDir, '@*/*/descriptor.json'),
    ];
    return this.scanPatterns(patterns, 'local');
  }

  /**
   * Scan the managed extensions directory for descriptor.json files.
   * @returns Discovered extensions from the managed install directory.
   */
  private async scanInstalled(): Promise<DiscoveredExtension[]> {
    if (this.extensionsDir === false) {
      return [];
    }
    const patterns = [
      path.join(this.extensionsDir, '*/descriptor.json'),
      path.join(this.extensionsDir, '@*/*/descriptor.json'),
    ];
    return this.scanPatterns(patterns, 'installed');
  }

  /**
   * Scan global npm node_modules for descriptor.json files.
   * @returns Discovered extensions from the global npm install directory.
   */
  private async scanGlobalNpm(): Promise<DiscoveredExtension[]> {
    if (this.nodeModulesDir === false) {
      return [];
    }
    const patterns = [
      path.join(this.nodeModulesDir, '*/descriptor.json'),
      path.join(this.nodeModulesDir, '@*/*/descriptor.json'),
    ];
    return this.scanPatterns(patterns, 'global-npm');
  }

  /**
   * Glob for descriptor.json files, parse and validate each.
   * Invalid descriptors are skipped with a warning.
   * @param patterns - Glob patterns to search.
   * @param source - The tier from which the results originate.
   * @returns List of successfully parsed and validated extensions.
   */
  private async scanPatterns(
    patterns: string[],
    source: DiscoveredExtension['source'],
  ): Promise<DiscoveredExtension[]> {
    const results: DiscoveredExtension[] = [];
    for (const pattern of patterns) {
      // Glob requires forward slashes even on Windows
      const normalizedPattern = pattern.split(path.sep).join('/');
      let matches: string[];
      try {
        matches = await glob(normalizedPattern, { windowsPathsNoEscape: true });
      } catch (err) {
        console.warn(
          `[extensions] Skipping scan for pattern ${normalizedPattern}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      for (const descriptorPath of matches) {
        try {
          const raw = await fs.readFile(descriptorPath, 'utf-8');
          const json: unknown = JSON.parse(raw);
          const descriptor = parseExtensionDescriptor(json);
          const extensionPath = path.dirname(descriptorPath);
          results.push({
            descriptor,
            extensionPath,
            source,
          });
        } catch (err) {
          console.warn(
            `[extensions] Skipping invalid descriptor at ${descriptorPath}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return results;
  }

  /**
   * Deduplicate by descriptor name across priority tiers.
   *
   * Tiers are processed in priority order — earlier tiers win on name collision.
   * @param tiers - Extension arrays ordered by descending priority.
   * @returns Merged list with no duplicate names.
   */
  private deduplicate(...tiers: DiscoveredExtension[][]): DiscoveredExtension[] {
    return deduplicateByDescriptorName(tiers);
  }
}

/**
 * Returns a pre-defined list of extensions without filesystem scanning.
 *
 * Used by tests and host-owned discovery flows where filesystem scanning is
 * unavailable or undesirable.
 */
export class ExplicitDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param extensions - Fixed list of extensions to return on every `discover()` call.
   */
  public constructor(private readonly extensions: DiscoveredExtension[]) {}

  /**
   * Return the fixed extension list provided at construction time.
   * @returns The extension list passed to the constructor.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    return this.extensions;
  }
}

/**
 * Merges multiple discovery strategies into one deduplicated result.
 *
 * Discoveries run concurrently via `Promise.all` and their results are
 * merged in constructor order. Earlier discoveries win on name collision,
 * which lets hosts layer explicit descriptor sets without changing the
 * existing tier semantics.
 */
export class MergedDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param discoveries - Discovery strategies ordered by descending priority.
   */
  public constructor(private readonly discoveries: ReadonlyArray<ExtensionDiscovery>) {}

  /**
   * Run all discoveries and merge their results by descriptor name.
   * @returns Deduplicated list preserving the first occurrence of each name.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const discoveredTiers = await Promise.all(this.discoveries.map((discovery) => discovery.discover()));
    return deduplicateByDescriptorName(discoveredTiers);
  }
}

/**
 * Deduplicate discoveries by descriptor name while preserving tier priority.
 * @param tiers - Discovery tiers ordered from highest to lowest priority.
 * @returns Merged discoveries with the first descriptor name occurrence kept.
 */
function deduplicateByDescriptorName(tiers: ReadonlyArray<ReadonlyArray<DiscoveredExtension>>): DiscoveredExtension[] {
  const byName = new Map<string, DiscoveredExtension>();
  for (const tier of tiers) {
    for (const ext of tier) {
      if (!byName.has(ext.descriptor.name)) {
        byName.set(ext.descriptor.name, ext);
      }
    }
  }
  return [...byName.values()];
}
