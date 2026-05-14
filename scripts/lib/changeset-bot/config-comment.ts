/**
 * Render and parse the changeset configuration comment posted on PRs.
 *
 * The comment contains per-package bump-type checkboxes with per-package
 * summaries extracted from CodeRabbit's Changes table. Rendering produces
 * the markdown; parsing extracts structured data back from the (possibly
 * edited) markdown.
 * @packageDocumentation
 */

import type { PackageChangeSummary } from './group-changes-by-package.js';

/** Bump type for a package version change. */
export type BumpType = 'patch' | 'minor' | 'major';

/** Parsed state of one package in the config comment. */
export interface PackageBump {
  readonly packageName: string;
  readonly bump: BumpType;
  readonly summaries: readonly string[];
}

/** Full parsed state of the config comment. */
export interface ConfigCommentState {
  readonly packages: readonly PackageBump[];
  readonly generateRequested: boolean;
}

/** HTML marker embedded in the comment for identification. */
const COMMENT_MARKER_PREFIX = '<!-- changeset-config:';

/**
 * Builds the HTML comment marker for a given PR number.
 * @param prNumber - The pull request number.
 * @returns The marker string.
 */
function buildMarker(prNumber: number): string {
  return `${COMMENT_MARKER_PREFIX}pr-${prNumber} -->`;
}

/**
 * Tests whether a comment body contains the changeset config marker.
 * @param body - The comment body to inspect.
 * @returns `true` if the body contains the marker.
 */
export function isConfigComment(body: string): boolean {
  return body.includes(COMMENT_MARKER_PREFIX);
}

/**
 * Renders a single package section.
 * @param pkg - Package change summary.
 * @returns Markdown block for one package.
 */
function renderPackageSection(pkg: PackageChangeSummary): string {
  const changes = pkg.summaries.map((s) => `- ${s}`).join('\n');

  return `## ${pkg.packageName}
### Bump:
_(Default: **patch**. Check to override.)_
- [ ] minor
- [ ] major

### Changes
${changes}`;
}

/**
 * Renders the changeset configuration comment with per-package summaries.
 * @param prNumber - Pull request number (embedded in the marker).
 * @param packages - Per-package change summaries.
 * @returns The full markdown body for the comment.
 */
export function renderConfigComment(prNumber: number, packages: readonly PackageChangeSummary[]): string {
  const marker = buildMarker(prNumber);
  const sorted = [...packages].sort((a, b) => a.packageName.localeCompare(b.packageName));

  const sections = sorted.map(renderPackageSection).join('\n\n---\n\n');

  return `${marker}
# 📦 Changelog

${sections}

---

- [ ] 🚀 Generate Changeset`;
}

const GENERATE_CHECKED = '- [x] 🚀 Generate Changeset';
const GENERATE_UNCHECKED = '- [ ] 🚀 Generate Changeset';

const PACKAGE_HEADING_RE = /^## (@\S+)\s*$/;
const MINOR_CHECKBOX_RE = /^- \[([x ])\] minor$/;
const MAJOR_CHECKBOX_RE = /^- \[([x ])\] major$/;
const CHANGE_BULLET_RE = /^- (.+)$/;
const GENERATE_RE = /^- \[([x ])\] 🚀 Generate Changeset$/m;

/**
 * Resolves the effective bump type from checkbox state.
 * @param minorChecked - Whether the minor checkbox is checked.
 * @param majorChecked - Whether the major checkbox is checked.
 * @returns The highest bump type (major > minor > patch).
 */
function resolveBump(minorChecked: boolean, majorChecked: boolean): BumpType {
  if (majorChecked) return 'major';
  if (minorChecked) return 'minor';
  return 'patch';
}

/**
 * Parses the changeset configuration comment to extract package bumps,
 * per-package summaries, and whether the Generate button was checked.
 * @param body - The raw markdown body of the config comment.
 * @returns Parsed state, or `null` if the body is not a config comment.
 */
export function parseConfigComment(body: string): ConfigCommentState | null {
  if (!isConfigComment(body)) return null;

  const packages: PackageBump[] = [];
  const lines = body.split('\n');

  let currentPkg: string | null = null;
  let minorChecked = false;
  let majorChecked = false;
  let summaries: string[] = [];
  let inChanges = false;

  /** Commits the current package and resets parser state. */
  function flushPackage(): void {
    if (currentPkg) {
      packages.push({
        packageName: currentPkg,
        bump: resolveBump(minorChecked, majorChecked),
        summaries,
      });
    }
    currentPkg = null;
    minorChecked = false;
    majorChecked = false;
    summaries = [];
    inChanges = false;
  }

  for (const line of lines) {
    const pkgMatch = PACKAGE_HEADING_RE.exec(line);
    if (pkgMatch) {
      flushPackage();
      currentPkg = pkgMatch[1];
      continue;
    }

    if (line === '---') {
      flushPackage();
      continue;
    }

    if (!currentPkg) continue;

    if (line === '### Changes') {
      inChanges = true;
      continue;
    }

    if (line.startsWith('### ')) {
      inChanges = false;
      continue;
    }

    if (!inChanges) {
      const minor = MINOR_CHECKBOX_RE.exec(line);
      if (minor) {
        minorChecked = minor[1] === 'x';
        continue;
      }
      const major = MAJOR_CHECKBOX_RE.exec(line);
      if (major) {
        majorChecked = major[1] === 'x';
        continue;
      }
    }

    if (inChanges) {
      const bullet = CHANGE_BULLET_RE.exec(line);
      if (bullet) {
        summaries.push(bullet[1]);
      }
    }
  }

  flushPackage();

  const generateMatch = GENERATE_RE.exec(body);
  const generateRequested = generateMatch?.[1] === 'x';

  return { packages, generateRequested };
}

/**
 * Resets the Generate checkbox in a config comment body from checked to unchecked.
 * @param body - The config comment body with a checked Generate checkbox.
 * @returns The body with the Generate checkbox unchecked.
 */
export function resetGenerateCheckbox(body: string): string {
  return body.replace(GENERATE_CHECKED, GENERATE_UNCHECKED);
}
