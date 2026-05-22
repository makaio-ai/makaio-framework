/**
 * Schema discovery for Drizzle migrations.
 *
 * Scans workspace packages for makaio.drizzleSchema declarations and resolves
 * them to absolute paths for aggregated schema generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverWorkspacePackageJsonPaths, parseWorkspaceGlobs } from '@makaio/utils/workspace-packages';

/**
 * A discovered schema file from a workspace package.
 */
export interface DiscoveredSchema {
  /** Package name (e.g., "\@makaio/services/session") */
  packageName: string;
  /** Absolute path to the schema file */
  schemaPath: string;
}

/**
 * Resolve workspace package globs from the root package.json.
 * @param workspaceRoot - Absolute path to the workspace root directory
 * @returns Array of workspace glob patterns
 * @throws Error if no workspaces are defined
 */
function resolveWorkspacePatterns(workspaceRoot: string): string[] {
  const rootPackagePath = path.resolve(workspaceRoot, 'package.json');
  const rootPackageRaw = fs.readFileSync(rootPackagePath, 'utf-8');
  const rootPackage = JSON.parse(rootPackageRaw) as unknown;
  const workspaces = parseWorkspaceGlobs(rootPackage);

  if (workspaces.length > 0) {
    return [...workspaces];
  }

  throw new Error(`No workspaces defined in ${rootPackagePath}`);
}

/**
 * Discover all Drizzle schema files declared in workspace packages.
 *
 * Scans package.json files in the workspace for `makaio.drizzleSchema` fields,
 * resolves relative paths to absolute paths, and validates that files exist.
 * @param workspaceRoot - Absolute path to the workspace root directory
 * @param patterns - Optional workspace glob patterns override. When provided, these
 *   patterns are used instead of the patterns from the root package.json workspaces field.
 * @returns Sorted array of discovered schemas (sorted by package name for deterministic output)
 * @throws Error if a declared schema file does not exist
 * @throws Error if `patterns` is provided as an empty array
 */
export async function discoverSchemas(workspaceRoot: string, patterns?: string[]): Promise<DiscoveredSchema[]> {
  if (patterns && patterns.length === 0) {
    throw new Error('discoverSchemas: patterns override must contain at least one glob');
  }
  const workspacePatterns = patterns ?? resolveWorkspacePatterns(workspaceRoot);

  const packageJsonPaths = await discoverWorkspacePackageJsonPaths(workspaceRoot, {
    patterns: workspacePatterns,
  });

  const discovered: DiscoveredSchema[] = [];

  for (const pkgPath of packageJsonPaths) {
    const pkgContent = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent) as {
      name?: string;
      makaio?: {
        drizzleSchema?: string | string[];
      };
    };

    if (!pkg.name || !pkg.makaio?.drizzleSchema) {
      continue;
    }

    const packageDir = path.dirname(pkgPath);
    const schemaPaths = Array.isArray(pkg.makaio.drizzleSchema) ? pkg.makaio.drizzleSchema : [pkg.makaio.drizzleSchema];

    for (const schemaPath of schemaPaths) {
      const absolutePath = path.resolve(packageDir, schemaPath);

      // Validate that schema file exists
      if (!fs.existsSync(absolutePath)) {
        throw new Error(
          `Schema file not found: ${absolutePath}\n` +
            `Declared in ${pkg.name} (${pkgPath})\n` +
            `Relative path: ${schemaPath}`,
        );
      }

      discovered.push({
        packageName: pkg.name,
        schemaPath: absolutePath,
      });
    }
  }

  // Sort by package name + schema path for deterministic output
  return discovered.sort((a, b) => {
    const byPackage = a.packageName.localeCompare(b.packageName);
    return byPackage !== 0 ? byPackage : a.schemaPath.localeCompare(b.schemaPath);
  });
}
