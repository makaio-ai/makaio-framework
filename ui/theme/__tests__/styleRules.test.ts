import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { globby } from 'globby';
import { describe, expect, it } from 'vitest';

const THEME_FILE = path.join(process.cwd(), 'ui/theme/themes/aura.scss');
const THEME_VAR_PREFIXES = ['--color-', '--glass-', '--font-', '--shadow-', '--radius-', '--z-'] as const;
const IGNORE_DIRS = ['ui/theme', 'node_modules', 'dist'] as const;

/**
 * Strip line and block comments from SCSS content.
 * @param content - Raw SCSS file contents
 * @returns Content with comments removed
 */
function stripComments(content: string): string {
  const withoutBlock = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlock.replace(/\/\/.*$/gm, '');
}

/**
 * Strip data URI strings from SCSS content.
 * Colors inside data URIs (e.g. SVG background-image) cannot use CSS variables.
 * @param content - SCSS content
 * @returns Content with data URIs removed
 */
function stripDataUris(content: string): string {
  return content.replace(/url\(["']data:[^)]+\)/g, '');
}

/**
 * Collect theme custom property names from the Aura theme file.
 * @param content - Theme SCSS content
 * @returns Set of CSS custom property names (e.g. --color-accent-primary)
 */
function collectThemeVars(content: string): Set<string> {
  const vars = new Set<string>();
  const regex = /(--[a-z0-9-]+)\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return vars;
}

/**
 * Extract CSS custom properties referenced via var() from SCSS content.
 * @param content - SCSS content without comments
 * @returns Set of referenced CSS custom property names
 */
function collectVarRefs(content: string): Set<string> {
  const vars = new Set<string>();
  const regex = /var\(\s*(--[a-z0-9-]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return vars;
}

/**
 * Find literal rgba() and hex color usages in SCSS content.
 * @param content - SCSS content without comments
 * @returns Array of literal color matches
 */
function findLiteralColors(content: string): string[] {
  const literals: string[] = [];
  const rgbaRegex = /rgba\(\s*\d/gi;
  const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;
  let match: RegExpExecArray | null;
  while ((match = rgbaRegex.exec(content)) !== null) {
    literals.push(match[0]);
  }
  while ((match = hexRegex.exec(content)) !== null) {
    literals.push(match[0]);
  }
  return literals;
}

/**
 * Check whether a repository-relative SCSS path should be ignored.
 * @param file - Repository-relative path.
 * @returns True when the file lives under an ignored directory.
 */
function shouldIgnoreFile(file: string): boolean {
  const normalized = file.replaceAll(/[\\/]+/g, '/');
  return IGNORE_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

describe('style rules', () => {
  it('ensures theme CSS vars referenced in modules exist in aura theme', async () => {
    const themeContent = await readFile(THEME_FILE, 'utf8');
    const themeVars = collectThemeVars(themeContent);
    const scssFiles = (await globby(['ui/**/*.module.scss'])).filter((file) => !shouldIgnoreFile(file));

    const missing: Array<{ file: string; vars: string[] }> = [];

    for (const file of scssFiles) {
      const raw = await readFile(file, 'utf8');
      const content = stripComments(raw);
      const refs = collectVarRefs(content);
      const scopedRefs = [...refs].filter((ref) => THEME_VAR_PREFIXES.some((prefix) => ref.startsWith(prefix)));
      const unknown = scopedRefs.filter((ref) => !themeVars.has(ref));
      if (unknown.length > 0) {
        missing.push({ file, vars: unknown });
      }
    }

    const report = missing.map((entry) => `${entry.file}: ${entry.vars.sort().join(', ')}`).join('\n');

    expect(missing, `Missing theme vars:\n${report}`).toEqual([]);
  });

  it('rejects literal rgba/hex colors outside theme packages', async () => {
    const scssFiles = (await globby(['ui/**/*.scss'])).filter((file) => !shouldIgnoreFile(file));
    const offenders: Array<{ file: string; matches: string[] }> = [];

    for (const file of scssFiles) {
      const raw = await readFile(file, 'utf8');
      const content = stripDataUris(stripComments(raw));
      const literals = findLiteralColors(content);
      if (literals.length > 0) {
        offenders.push({ file, matches: literals });
      }
    }

    const report = offenders.map((entry) => `${entry.file}: ${entry.matches.join(', ')}`).join('\n');

    expect(offenders, `Literal colors found:\n${report}`).toEqual([]);
  });
});
