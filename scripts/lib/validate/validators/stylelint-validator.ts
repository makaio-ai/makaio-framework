import * as fs from 'fs/promises';
import * as path from 'path';
import type { ValidatorContext } from '../util/validator-context.js';
import type { StylelintApi } from '../util/tool-loader.js';

/** Candidate theme file for the current framework UI topology. */
const THEME_FILES = ['framework/ui/theme/themes/aura.scss'] as const;

/** Theme custom property prefixes that must exist in the theme file */
const THEME_VAR_PREFIXES = ['--color-', '--glass-', '--font-', '--shadow-', '--radius-', '--z-'] as const;

/** Directories to ignore when scanning for SCSS files */
const IGNORE_DIRS = ['framework/ui/theme', 'node_modules', 'dist'];

/**
 * Extracts CSS custom property names from an SCSS theme file.
 *
 * Parses the theme file and extracts all `--property-name:` definitions,
 * returning them as a set of property names for validation.
 * @param themeFilePath - Absolute path to the theme SCSS file
 * @returns Promise resolving to Set of CSS custom property names (e.g., '--color-accent-primary')
 */
async function extractCssCustomProperties(themeFilePath: string): Promise<Set<string>> {
  const properties = new Set<string>();

  try {
    const content = await fs.readFile(themeFilePath, 'utf-8');
    // Match CSS custom property definitions: --property-name:
    const regex = /--([\w-]+)\s*:/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      properties.add(`--${match[1]}`);
    }
  } catch (error) {
    console.warn(`Warning: Could not read theme file ${themeFilePath}: ${error}`);
  }

  return properties;
}

/**
 * Resolve the active theme file for the current repository topology.
 * @param cwd - Current working directory
 * @returns Absolute theme file path, or `null` when no theme file exists
 */
async function resolveThemeFilePath(cwd: string): Promise<string | null> {
  for (const relativePath of THEME_FILES) {
    const candidate = path.join(cwd, relativePath);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next topology-specific theme path.
    }
  }

  return null;
}

/**
 * Extracts CSS custom property references from an SCSS file.
 *
 * Parses the file and extracts all `var(--property-name)` usages,
 * returning them with their line/column positions for error reporting.
 * @param content - File content to parse
 * @returns Array of property references with location info
 */
function extractCssVarReferences(content: string): Array<{
  property: string;
  line: number;
  column: number;
}> {
  const references: Array<{ property: string; line: number; column: number }> = [];
  const lines = content.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    // Match var(--property-name) or var(--property-name, fallback).
    // The lookahead (?=[),\s]) ensures partial SCSS interpolations like
    // var(--color-#{$name}) are not captured as incomplete property names.
    const regex = /var\(\s*(--[\w-]+)(?=[),\s])/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      references.push({
        property: match[1],
        line: lineIndex + 1, // 1-based
        column: match.index + 1, // 1-based
      });
    }
  }

  return references;
}

/**
 * Checks if a file should be ignored based on its path.
 * @param filePath - File path to check
 * @param cwd - Current working directory
 * @returns True if file should be ignored
 */
function shouldIgnoreFile(filePath: string, cwd: string): boolean {
  const relativePath = path.relative(cwd, filePath).replaceAll(/[\\/]+/g, '/');
  return IGNORE_DIRS.some((dir) => relativePath === dir || relativePath.startsWith(`${dir}/`));
}

/**
 * Validates CSS custom property existence in SCSS files.
 *
 * Extracts known properties from the theme file and checks that all
 * var(--*) references in SCSS files use defined properties.
 * @param files - Absolute file paths to validate
 * @param cwd - Current working directory for relative path resolution
 * @param ctx - Validator context for storing results
 * @returns Promise resolving to object with themeFound flag and filesChecked
 */
async function validateCssVarExistence(
  files: string[],
  cwd: string,
  ctx: ValidatorContext,
): Promise<{ themeFound: boolean; filesChecked: string[] }> {
  const themeFilePath = await resolveThemeFilePath(cwd);
  if (!themeFilePath) {
    return { themeFound: false, filesChecked: [] };
  }

  const themeFileLabel = path.relative(cwd, themeFilePath);
  const knownProperties = await extractCssCustomProperties(themeFilePath);
  const themeFound = knownProperties.size > 0;
  const filesChecked: string[] = [];

  for (const file of files) {
    if (!file.endsWith('.scss') && !file.endsWith('.css')) continue;
    if (shouldIgnoreFile(file, cwd)) continue;

    filesChecked.push(file);

    try {
      const content = await fs.readFile(file, 'utf-8');
      const references = extractCssVarReferences(content);

      for (const ref of references) {
        if (!THEME_VAR_PREFIXES.some((prefix) => ref.property.startsWith(prefix))) {
          continue;
        }
        if (!knownProperties.has(ref.property)) {
          ctx.addResult(file, {
            tool: 'stylelint',
            message: `Unknown CSS custom property "${ref.property}" - not defined in ${themeFileLabel}`,
            severity: 'error',
            line: ref.line,
            column: ref.column,
            fixable: false,
            ruleId: 'css-var-existence',
          });
        }
      }
    } catch (error) {
      ctx.addResult(file, {
        tool: 'stylelint',
        message: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        fixable: false,
      });
    }
  }

  return { themeFound, filesChecked };
}

/**
 * Validates files with Stylelint.
 *
 * Runs two validation passes:
 * 1. CSS custom property existence check (custom implementation)
 * 2. Stylelint rules from project config
 * @param files - Absolute file paths to validate
 * @param stylelintApi - Stylelint module API instance for linting
 * @param ctx - Validator context for storing results
 * @param autoFix - Whether to auto-fix issues (applies to stylelint rules only)
 * @returns Promise resolving to object with configFound flag and filesChecked
 */
export async function validateStylelint(
  files: string[],
  stylelintApi: StylelintApi,
  ctx: ValidatorContext,
  autoFix?: boolean,
): Promise<{ configFound: boolean; filesChecked: string[] }> {
  const cwd = process.cwd();
  let configFound = false;
  const allFilesChecked = new Set<string>();

  // Filter to only SCSS files not in ignored directories
  const scssFiles = files.filter((f) => {
    const isScss = f.endsWith('.scss');
    const isIgnored = shouldIgnoreFile(f, cwd);
    return isScss && !isIgnored;
  });

  if (scssFiles.length === 0) {
    return { configFound: false, filesChecked: [] };
  }

  // Pass 1: Check CSS custom property existence (fast, custom implementation)
  const varCheckResult = await validateCssVarExistence(scssFiles, cwd, ctx);
  varCheckResult.filesChecked.forEach((f) => allFilesChecked.add(f));

  // Pass 2: Run stylelint rules
  try {
    const result = await stylelintApi.lint({
      files: scssFiles,
      fix: autoFix,
    });

    configFound = true; // If lint() succeeds, config was found

    for (const fileResult of result.results) {
      allFilesChecked.add(fileResult.source || '');

      for (const warning of fileResult.warnings) {
        // When fix=true, stylelint writes fixes directly to files.
        // Remaining warnings are unfixable issues.
        ctx.addResult(fileResult.source || '', {
          tool: 'stylelint',
          message: warning.text,
          severity: warning.severity === 'error' ? 'error' : 'warning',
          line: warning.line,
          column: warning.column,
          endLine: warning.endLine,
          endColumn: warning.endColumn,
          ruleId: warning.rule,
          fixable: false,
          fixedAutomatically: false,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isNoConfig = /no configuration provided|could not find/i.test(msg);

    if (!isNoConfig) {
      // Report as a general error for the first file
      const firstFile = scssFiles[0];
      if (firstFile) {
        ctx.addResult(firstFile, {
          tool: 'stylelint',
          message: `Stylelint error: ${msg}`,
          severity: 'error',
          fixable: false,
        });
      }
    }
    // If no config, that's expected - varCheckResult still ran
  }

  return {
    configFound: configFound || varCheckResult.themeFound,
    filesChecked: Array.from(allFilesChecked),
  };
}
