import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { isFrameworkDistributionRoot, relativeInventoryPath } from './path-utils.js';

/**
 * Creates a TS program from the analysis root tsconfig.json.
 * This gives us access to the full type checker across the selected analysis root.
 * @param analysisRoot - Absolute path to the analysis root directory.
 * @returns A TypeScript `Program` covering all workspace source files.
 */
export function createAnalysisProgram(analysisRoot: string): ts.Program {
  const tsConfigPath = path.join(analysisRoot, 'tsconfig.json');
  if (!fs.existsSync(tsConfigPath)) {
    throw new Error(`No tsconfig.json found at: ${tsConfigPath}`);
  }

  const { config, error } = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (error) {
    throw new Error(`Failed to read tsconfig.json: ${formatDiagnosticMessage(error)}`);
  }

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, analysisRoot);
  if (parsed.errors.length > 0) {
    throw new Error(`Failed to parse tsconfig.json: ${parsed.errors.map(formatDiagnosticMessage).join('\n')}`);
  }

  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
}

/**
 * Formats a TypeScript diagnostic for script-level error messages.
 * @param diagnostic - The diagnostic to format.
 * @returns A flattened diagnostic message string.
 */
function formatDiagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

/**
 * Resolves the nearest package.json name for a file path.
 * @param filePath - Absolute path to the source file.
 * @returns The `name` field from the nearest ancestor `package.json`, or `null` if not found.
 */
export function resolvePackageName(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.name ?? null;
      } catch {
        return null;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Classifies a file path into a tier based on its position in the repo.
 * @param filePath - Absolute path to the source file being classified.
 * @param analysisRoot - Absolute path to the analysis root directory.
 * @returns The tier string: `'framework'`, `'product'`, `'product-web'`, or `'extension'`.
 */
export function classifyTier(
  filePath: string,
  analysisRoot: string,
): 'framework' | 'product' | 'product-web' | 'extension' {
  const rel = relativeInventoryPath(analysisRoot, filePath);

  if (isFrameworkDistributionRoot(analysisRoot)) {
    return rel.startsWith('extensions/') ? 'extension' : 'framework';
  }

  if (rel.startsWith('product/web/')) return 'product-web';
  if (rel.startsWith('product/extensions/')) return 'extension';
  if (rel.startsWith('product/')) return 'product';
  if (rel.startsWith('framework/extensions/')) return 'extension';
  if (rel.startsWith('framework/')) return 'framework';

  return 'product';
}
