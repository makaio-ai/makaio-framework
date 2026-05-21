import type { MakaioBusLike } from '@makaio/core';

/**
 * Context passed to bootstrap discovery and export operations.
 * @typeParam TBus - Host bus shape supplied by the runtime.
 */
export interface BootstrapDiscoverContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Bus instance for querying the runtime. */
  bus: TBus;
  /** Active project identifier. */
  projectId: string;
  /** Absolute path to the project repository. */
  repoPath: string;
}

/** Context for export operations - identical to discover context. */
export type BootstrapExportContext<TBus extends MakaioBusLike = MakaioBusLike> = BootstrapDiscoverContext<TBus>;

/** Context for import operations - extends discover context with the bootstrap folder path. */
export interface BootstrapImportContext<TBus extends MakaioBusLike = MakaioBusLike>
  extends BootstrapDiscoverContext<TBus> {
  /** Absolute path to the `.makaio/bootstrap/` folder being imported from. */
  bootstrapFolderPath: string;
}

/** A single exportable or importable bootstrap asset. */
export interface BootstrapAsset {
  /** Identifier of the extension that owns this asset. */
  extensionId: string;
  /** Logical asset type (e.g. `'session'`, `'config'`). */
  type: string;
  /** Human-readable asset name. */
  name: string;
  /** Filename within the bootstrap folder. */
  filename: string;
  /** Whether the asset already exists in the target environment. */
  exists?: boolean;
  /** Identifier of an existing asset that would be replaced by import. */
  existingId?: string;
}

/** Stable key type for bootstrap asset lookups. */
export type BootstrapAssetKey = string;

/**
 * Build a stable key for a bootstrap asset.
 * @param asset - The asset to key.
 * @returns Stable asset key for UI state and list rendering.
 */
export function getBootstrapAssetKey(asset: BootstrapAsset): BootstrapAssetKey {
  return JSON.stringify([asset.extensionId, asset.type, asset.name, asset.filename]);
}

/** Result of a single bootstrap import operation. */
export interface BootstrapImportResult {
  /** Whether the import succeeded. */
  success: boolean;
  /** Action taken during import. */
  action: 'created' | 'replaced' | 'skipped';
  /** Error message when `success` is `false`. */
  error?: string;
}

/** User-selected action for a conflicting bootstrap asset. */
export interface BootstrapChoice {
  /** The conflicting asset. */
  asset: BootstrapAsset;
  /** Chosen resolution action. */
  action: 'replace' | 'skip';
}

/** Result of a completed bootstrap operation (import or export). */
export interface BootstrapResult {
  /** The asset that was processed. */
  asset: BootstrapAsset;
  /** Action taken. */
  action: 'replaced' | 'skipped' | 'created';
  /** Error message when the operation failed. */
  error?: string;
}

/** Result of a bootstrap export operation. */
export interface BootstrapExportResult {
  /** The asset that was exported. */
  asset: BootstrapAsset;
  /** Absolute path to the file that was written. */
  filePath: string;
  /** Error message when the export failed. */
  error?: string;
}

/**
 * Bootstrap capability contributed by an extension.
 *
 * Participates in project export (`discoverExportable` + `export`) and
 * project import (`listImportable` + `import`) workflows.
 * @typeParam TBus - Host bus shape supplied by the runtime.
 */
export interface ExtensionBootstrap<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Subfolder name within `.makaio/bootstrap/` for this extension's assets. */
  folder: string;
  /**
   * List assets that can be imported from the bootstrap folder.
   * @param ctx - Import context with bus, project, and bootstrap folder path.
   * @param files - Files present in the bootstrap folder.
   * @returns Assets available for import.
   */
  listImportable: (ctx: BootstrapImportContext<TBus>, files: string[]) => Promise<BootstrapAsset[]>;
  /**
   * Discover assets available for export from the current project.
   * @param ctx - Discovery context with bus and project info.
   * @returns Assets that can be exported.
   */
  discoverExportable: (ctx: BootstrapDiscoverContext<TBus>) => Promise<BootstrapAsset[]>;
  /**
   * Export a single asset and return its serialized content.
   * @param ctx - Export context with bus and project info.
   * @param asset - The asset to export.
   * @returns Serialized content string written to the bootstrap folder.
   */
  export: (ctx: BootstrapExportContext<TBus>, asset: BootstrapAsset) => Promise<string>;
  /**
   * Import a single asset from its serialized content.
   * @param ctx - Import context with bus, project, and bootstrap folder path.
   * @param asset - The asset being imported.
   * @param content - Serialized content string from the bootstrap folder.
   * @param action - User-selected conflict resolution action.
   * @returns Result of the import operation.
   */
  import: (
    ctx: BootstrapImportContext<TBus>,
    asset: BootstrapAsset,
    content: string,
    action: 'replace' | 'skip',
  ) => Promise<BootstrapImportResult>;
}
