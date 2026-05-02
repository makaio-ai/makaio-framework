import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import { TypeAnalyzer, type TypeAliasAnalysis, type TypeCompositionNode } from '@makaio/type-lens/type-analysis';
import { writeApiSymbolManifest } from './api-symbol-manifest';
import { toApiSlug } from './api-route-utils';

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUTPUT_DIR = path.resolve(import.meta.dirname, '..', 'src/content/docs/reference/api');
const SYMBOL_MANIFEST_PATH = path.resolve(import.meta.dirname, '..', '.api-symbol-manifest.json');
const GENERATED_ENTRYPOINT_DIR = path.resolve(import.meta.dirname, '..', '.typedoc-entrypoints');
const TYPEDOC_CONFIG = path.join(FRAMEWORK_ROOT, 'typedoc.json');
const GENERATED_TYPEDOC_CONFIG = path.join(GENERATED_ENTRYPOINT_DIR, 'typedoc.json');
const GENERATED_TSCONFIG = path.join(GENERATED_ENTRYPOINT_DIR, 'tsconfig.json');
const FRAMEWORK_SOURCE_LINK_TEMPLATE = 'https://github.com/makaio-ai/makaio-framework/blob/main/{path}#L{line}';

const require = createRequire(import.meta.url);
const typedocPackageRoot = path.dirname(require.resolve('typedoc/package.json'));
const typedocBin = path.join(typedocPackageRoot, 'bin/typedoc');

interface CreatePublicApiEntryPointsOptions {
  frameworkRoot: string;
  packageRoots: string[];
  entrypointRoot: string;
}

interface PackageJson {
  name?: unknown;
  exports?: unknown;
}

interface TypeDocConfig {
  entryPoints?: unknown;
  packageOptions?: unknown;
  [key: string]: unknown;
}

/**
 * Converts a package name to the route segment used by the generated API docs.
 * @param packageName - Package name from package.json.
 * @returns Stable route segment without an npm scope.
 */
function packageSlug(packageName: string): string {
  return packageName.startsWith('@') ? (packageName.split('/')[1] ?? packageName) : packageName;
}

/**
 * Returns whether an export target represents TypeScript source that should be documented.
 * @param exportKey - Package export key from package.json.
 * @param target - Export target path.
 * @returns True when the export is a public API source entrypoint.
 */
function isDocumentedExport(exportKey: string, target: string): boolean {
  if (exportKey === './package.json') return false;
  if (exportKey.endsWith('/register')) return false;
  if (path.basename(target) === 'register.ts') return false;
  return target.endsWith('.ts');
}

/**
 * Resolves package export targets to a TypeScript source path.
 * @param exportKey - Package export key from package.json.
 * @param exportTarget - Raw package.json export target.
 * @param packageName - Package name used in diagnostics.
 * @returns Source path for supported export targets.
 */
function resolveExportTarget(exportKey: string, exportTarget: unknown, packageName: string): string {
  if (typeof exportTarget === 'string') return exportTarget;

  if (exportTarget && typeof exportTarget === 'object' && !Array.isArray(exportTarget)) {
    const conditions = exportTarget as Record<string, unknown>;
    const target = conditions.types ?? conditions.import ?? conditions.default;
    if (typeof target === 'string') return target;
  }

  throw new Error(`Export ${exportKey} in ${packageName} must resolve to a string TypeScript source target.`);
}

/**
 * Maps a package export key to its generated docs barrel path.
 * @param slug - Package route segment.
 * @param exportKey - Package export key from package.json.
 * @returns Generated barrel path relative to the entrypoint root.
 */
function entrypointRelativePath(slug: string, exportKey: string): string {
  const subpath = exportKey === '.' ? [] : exportKey.replace(/^\.\//, '').split('/');
  return path.join(slug, ...subpath, 'index.ts');
}

/**
 * Creates virtual barrels for the public package exports documented by TypeDoc.
 * @param options - Framework root, package roots, and generated entrypoint root.
 * @returns Absolute generated entrypoint file paths.
 */
export function createPublicApiEntryPoints(options: CreatePublicApiEntryPointsOptions): string[] {
  const entryPoints: string[] = [];

  fs.rmSync(options.entrypointRoot, { recursive: true, force: true });
  fs.mkdirSync(options.entrypointRoot, { recursive: true });

  for (const packageRoot of options.packageRoots) {
    const relativePackageRoot = path.relative(options.frameworkRoot, packageRoot);
    if (relativePackageRoot.startsWith('..') || path.isAbsolute(relativePackageRoot)) {
      throw new Error(`Package root ${packageRoot} is outside framework root ${options.frameworkRoot}.`);
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as PackageJson;
    if (typeof packageJson.name !== 'string') {
      throw new Error(`Package at ${packageRoot} does not declare a string name.`);
    }
    if (!packageJson.exports || typeof packageJson.exports !== 'object' || Array.isArray(packageJson.exports)) {
      throw new Error(`Package ${packageJson.name} does not declare object exports.`);
    }

    const slug = packageSlug(packageJson.name);
    for (const [exportKey, rawTarget] of Object.entries(packageJson.exports)) {
      const target = resolveExportTarget(exportKey, rawTarget, packageJson.name);
      if (!isDocumentedExport(exportKey, target)) continue;

      const entrypointPath = path.join(options.entrypointRoot, entrypointRelativePath(slug, exportKey));
      const resolvedSourcePath = path.resolve(packageRoot, target);
      const relativeSourcePath = path.relative(packageRoot, resolvedSourcePath);
      if (relativeSourcePath.startsWith('..') || path.isAbsolute(relativeSourcePath)) {
        throw new Error(`Export ${exportKey} in ${packageJson.name} points outside ${packageRoot}.`);
      }
      const sourcePath = resolvedSourcePath.replace(/\.ts$/, '.js');
      let importPath = path.relative(path.dirname(entrypointPath), sourcePath).replaceAll(path.sep, '/');
      if (!importPath.startsWith('.')) importPath = `./${importPath}`;

      fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
      fs.writeFileSync(entrypointPath, `export * from '${importPath}';\n`);
      entryPoints.push(entrypointPath);
    }
  }

  return entryPoints;
}

/**
 * Reads the configured framework packages that should appear in the API reference.
 * @param configPath - TypeDoc configuration path.
 * @returns Absolute package root paths.
 */
function readConfiguredPackageRoots(configPath: string): string[] {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as TypeDocConfig;
  if (!Array.isArray(config.entryPoints) || !config.entryPoints.every((entry) => typeof entry === 'string')) {
    throw new Error(`Expected ${configPath} to declare string entryPoints.`);
  }
  return config.entryPoints.map((entryPoint) => path.resolve(FRAMEWORK_ROOT, entryPoint));
}

/**
 * Writes a temporary TypeDoc config for generated public API entrypoints.
 * @param entryPoints - Generated virtual barrel entrypoints.
 */
function writeGeneratedTypeDocConfig(entryPoints: string[]): void {
  const config = JSON.parse(fs.readFileSync(TYPEDOC_CONFIG, 'utf8')) as TypeDocConfig;
  delete config.packageOptions;
  config.entryPoints = entryPoints;
  config.entryPointStrategy = 'resolve';
  config.basePath = GENERATED_ENTRYPOINT_DIR;
  config.tsconfig = GENERATED_TSCONFIG;
  applyFrameworkSourceLinkOptions(config);

  fs.writeFileSync(GENERATED_TYPEDOC_CONFIG, JSON.stringify(config, null, 2));
}

/**
 * Configures TypeDoc source links for the framework source repository.
 * @param config - Mutable TypeDoc configuration object.
 */
export function applyFrameworkSourceLinkOptions(config: TypeDocConfig): void {
  config.gitRevision = 'main';
  config.sourceLinkTemplate = FRAMEWORK_SOURCE_LINK_TEMPLATE;
}

/**
 * Rewrites generated source links to the public framework source repository.
 * @param content - Generated TypeDoc Markdown content.
 * @returns Markdown content with canonical framework source links.
 */
export function normalizeFrameworkSourceLinks(content: string): string {
  return content.replaceAll(
    /\[([^\]]+)\]\(https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+\/blob\/[^/)]+\/framework\/([^)#\s]+)(#[^)\s]+)?\)/gu,
    (_match, _label: string, sourcePath: string, hash: string | undefined) => {
      const line = hash?.match(/^#L(\d+)$/u)?.[1];
      const label = line ? `${sourcePath}:${line}` : sourcePath;
      return `[${label}](https://github.com/makaio-ai/makaio-framework/blob/main/${sourcePath}${hash ?? ''})`;
    },
  );
}

/**
 * Writes a temporary TypeScript project that explicitly includes generated entrypoints.
 * @param entryPoints - Generated virtual barrel entrypoints.
 */
function writeGeneratedTsConfig(entryPoints: string[]): void {
  fs.writeFileSync(
    GENERATED_TSCONFIG,
    JSON.stringify(
      {
        extends: path.join(FRAMEWORK_ROOT, 'tsconfig.json'),
        files: entryPoints,
      },
      null,
      2,
    ),
  );
}

/**
 * Removes Markdown escape characters that TypeDoc keeps in heading text but
 * Starlight frontmatter renders literally.
 * @param title - Title extracted from a TypeDoc Markdown heading.
 * @returns Human-readable page title for frontmatter.
 */
export function normalizeTypeDocPageTitle(title: string): string {
  return title.replace(/\\([\\`*_[\]{}()#+\-.!<>|])/gu, '$1').replace(/[`*]/g, '');
}

/**
 * Builds Starlight frontmatter for a generated TypeDoc Markdown page.
 * @param filePath - Generated Markdown file path.
 * @param title - Title extracted from the generated page body.
 * @returns Frontmatter text to prepend to the generated page.
 */
function frontmatterFor(filePath: string, title: string): string {
  const relativePath = path.relative(OUTPUT_DIR, filePath);
  const isApiIndex = relativePath === 'index.md';
  const isMediaPage = relativePath.split(path.sep).includes('_media');
  const resolvedTitle = isApiIndex ? 'API Reference' : normalizeTypeDocPageTitle(title);
  const sidebar = isMediaPage ? 'sidebar:\n  hidden: true\npagefind: false\n' : '';

  return `---\ntitle: ${JSON.stringify(resolvedTitle)}\neditUrl: false\nprev: false\nnext: false\n${sidebar}---\n\n`;
}

/**
 * Adds Starlight frontmatter to a TypeDoc Markdown file when it has none.
 * @param filePath - Generated Markdown file path.
 */
function addFrontmatter(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.startsWith('---\n')) {
    fs.writeFileSync(filePath, normalizeFrameworkSourceLinks(content));
    return;
  }

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? path.basename(filePath, '.md');

  fs.writeFileSync(filePath, frontmatterFor(filePath, title) + normalizeFrameworkSourceLinks(content));
}

/**
 * Adds type-composition and resolved-shape analysis to a generated TypeDoc page.
 * @param pagePath - Generated Markdown page to update.
 * @param analysis - Type alias analysis to render.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 */
export function augmentTypeAliasPageWithAnalysis(
  pagePath: string,
  analysis: TypeAliasAnalysis,
  symbolManifest: Record<string, string>,
): void {
  const content = fs.readFileSync(pagePath, 'utf-8');
  fs.writeFileSync(pagePath, `${content.trimEnd()}\n\n${renderTypeAliasAnalysis(analysis, symbolManifest)}`);
}

/**
 * Adds type-analysis sections to generated type alias pages when analysis exists.
 * @param outputDir - Root of the generated TypeDoc Markdown output.
 * @param entryPoints - Public API entrypoints used for TypeDoc generation.
 * @param tsconfigPath - TypeScript project configuration used by the analyzer.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 */
function augmentTypeAliasPages(
  outputDir: string,
  entryPoints: string[],
  tsconfigPath: string,
  symbolManifest: Record<string, string>,
): void {
  const analyzer = new TypeAnalyzer({ entryPoints, tsconfigPath });

  for (const pagePath of findTypeAliasPages(outputDir)) {
    const symbolName = path.basename(pagePath, '.md');
    const analysis = analyzer.analyzeExportedTypeAlias(symbolName);
    if (!analysis) continue;
    augmentTypeAliasPageWithAnalysis(pagePath, analysis, symbolManifest);
  }
}

/**
 * Rewrites TypeDoc's relative symbol links to canonical website routes.
 * @param content - Generated TypeDoc Markdown content.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 * @param pageContext - Generated page path context used to resolve relative targets.
 * @returns Markdown content with canonical symbol links.
 */
export function rewriteTypeDocSymbolLinks(
  content: string,
  symbolManifest: Record<string, string>,
  pageContext?: { pagePath: string; outputDir: string },
): string {
  return content.replaceAll(
    /\]\((?!#|[a-z][a-z0-9+.-]*:|\/)([^)\s]*\/)?([^/)\s#]+)\.md(#[^)\s]+)?\)/giu,
    (match, relativeDir: string | undefined, symbolName: string, fragment: string | undefined) => {
      const href = pageContext
        ? routeForMarkdownTarget(
            path.resolve(path.dirname(pageContext.pagePath), `${relativeDir ?? ''}${symbolName}.md`),
            pageContext.outputDir,
          )
        : symbolManifest[symbolName];
      return href ? `](${href}${fragment ?? ''})` : match;
    },
  );
}

/**
 * Converts a generated Markdown target path into its canonical website route.
 * @param targetPath - Resolved generated Markdown file path.
 * @param outputDir - Root of the generated TypeDoc Markdown output.
 * @returns Canonical website route when the target is inside generated output.
 */
function routeForMarkdownTarget(targetPath: string, outputDir: string): string | undefined {
  const relativeTarget = path.relative(outputDir, targetPath);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget) || !relativeTarget.endsWith('.md')) {
    return undefined;
  }

  const routeParts = relativeTarget.split(path.sep).map((part, index, parts) => {
    if (index !== parts.length - 1) return part;
    return toApiSlug(path.basename(part, '.md'));
  });
  return `/reference/api/${routeParts.join('/')}/`;
}

/**
 * Rewrites symbol links across generated TypeDoc Markdown files.
 * @param dir - Directory to scan.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 * @param outputDir - Root of the generated TypeDoc Markdown output.
 */
function rewriteTypeDocSymbolLinksInDir(
  dir: string,
  symbolManifest: Record<string, string>,
  outputDir: string = dir,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteTypeDocSymbolLinksInDir(full, symbolManifest, outputDir);
    } else if (entry.name.endsWith('.md')) {
      fs.writeFileSync(
        full,
        rewriteTypeDocSymbolLinks(fs.readFileSync(full, 'utf-8'), symbolManifest, {
          pagePath: full,
          outputDir,
        }),
      );
    }
  }
}

/**
 * Finds all generated TypeDoc type alias Markdown pages.
 * @param dir - Directory to scan.
 * @returns Absolute Markdown file paths.
 */
function findTypeAliasPages(dir: string): string[] {
  const pages: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pages.push(...findTypeAliasPages(full));
    } else if (entry.name.endsWith('.md') && path.basename(path.dirname(full)) === 'type-aliases') {
      pages.push(full);
    }
  }

  return pages;
}

/**
 * Renders the Markdown section for a type alias analysis.
 * @param analysis - Type alias analysis to render.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 * @returns Markdown section.
 */
function renderTypeAliasAnalysis(analysis: TypeAliasAnalysis, symbolManifest: Record<string, string>): string {
  const lines = [
    '<!-- api-type-analysis:start -->',
    '',
    '## Type Composition',
    '',
    ...renderCompositionNode(analysis.composition, symbolManifest, 0),
  ];

  if (analysis.resolvedShape) {
    lines.push('', '## Resolved Shape', '', ...renderResolvedShape(analysis));
  }

  lines.push('', '<!-- api-type-analysis:end -->');
  return lines.join('\n');
}

/**
 * Renders an indented type composition tree.
 * @param node - Composition node to render.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 * @param depth - Current indentation depth.
 * @returns Markdown list lines.
 */
function renderCompositionNode(
  node: TypeCompositionNode,
  symbolManifest: Record<string, string>,
  depth: number,
): string[] {
  const indent = '  '.repeat(depth);
  return [
    `${indent}- ${renderSymbolCode(node, symbolManifest)}`,
    ...node.children.flatMap((child) => renderCompositionNode(child, symbolManifest, depth + 1)),
  ];
}

/**
 * Renders a symbol or type expression as code, linked when it has an API page.
 * @param node - Composition node to render.
 * @param symbolManifest - Map of API symbol names to generated website routes.
 * @returns Markdown inline code or linked inline code.
 */
function renderSymbolCode(node: TypeCompositionNode, symbolManifest: Record<string, string>): string {
  const href = node.symbolName ? symbolManifest[node.symbolName] : undefined;
  const code = `\`${node.text}\``;
  return href ? `[${code}](${href})` : code;
}

/**
 * Renders a resolved type shape.
 * @param analysis - Type alias analysis to render.
 * @returns Markdown lines for the shape.
 */
function renderResolvedShape(analysis: TypeAliasAnalysis): string[] {
  const shape = analysis.resolvedShape;
  if (!shape) return [];

  if (shape.kind === 'omitted') {
    return [shape.reason];
  }

  return [
    '```ts',
    `type ${analysis.symbolName} = {`,
    ...shape.properties.map((property) => `  ${property.name}${property.optional ? '?' : ''}: ${property.type};`),
    '};',
    '```',
  ];
}

/**
 * Creates an Astro integration that generates TypeDoc Markdown before Starlight loads content.
 * @returns Astro integration for generated API reference pages.
 */
export function generateApiReference(): AstroIntegration {
  return {
    name: 'generate-api-reference',
    hooks: {
      'astro:config:setup': () => {
        if (fs.existsSync(OUTPUT_DIR)) {
          fs.rmSync(OUTPUT_DIR, { recursive: true });
        }
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });

        const entryPoints = createPublicApiEntryPoints({
          frameworkRoot: FRAMEWORK_ROOT,
          packageRoots: readConfiguredPackageRoots(TYPEDOC_CONFIG),
          entrypointRoot: GENERATED_ENTRYPOINT_DIR,
        });
        writeGeneratedTsConfig(entryPoints);
        writeGeneratedTypeDocConfig(entryPoints);

        execFileSync(process.execPath, [typedocBin, '--options', GENERATED_TYPEDOC_CONFIG, '--out', OUTPUT_DIR], {
          cwd: FRAMEWORK_ROOT,
          stdio: 'inherit',
          timeout: 300_000,
        });

        // Add frontmatter to all generated .md files
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.name.endsWith('.md')) {
              addFrontmatter(full);
            }
          }
        };
        walk(OUTPUT_DIR);

        const symbolManifest = writeApiSymbolManifest(OUTPUT_DIR, SYMBOL_MANIFEST_PATH);
        rewriteTypeDocSymbolLinksInDir(OUTPUT_DIR, symbolManifest);
        augmentTypeAliasPages(OUTPUT_DIR, entryPoints, GENERATED_TSCONFIG, symbolManifest);
      },
    },
  };
}
