/**
 * Declaration-shaped invariants of the framework distribution.
 *
 * The distribution's runtime checks reason about the import graph of built
 * `.mjs` modules. The invariants here instead constrain the shipped `.d.mts`
 * files: whether a declaration target carries an API surface at all, and
 * whether a declaration bundle inlined the workspace types it was supposed to.
 * Neither is observable from the runtime artifact — a consumer that only
 * executes the bundle sees nothing wrong — so both are checked against the
 * declaration files directly, independently of which TypeScript backend
 * emitted them.
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import type { FrameworkDistIssue } from './framework-dist-verifier.js';

/**
 * Matches exports-map declaration targets (`.d.ts`, `.d.mts`, `.d.cts`) — the
 * only targets a runtime-only distribution legitimately omits.
 */
export const DECLARATION_TARGET_PATTERN = /\.d\.[cm]?ts$/;

/**
 * Matches the first token that gives a declaration file any API surface.
 *
 * A declaration file without one resolves and type-checks as a module with no
 * exports, so consumers see the subpath as untyped instead of failing to
 * resolve it. This is the emptiness that matters: a zero-byte file, a file
 * holding only comments or blank lines, and a file holding only the bare
 * module marker `export {};` are equally surface-free, and only a declaration
 * backend that emitted nothing produces any of them. Nothing else observes
 * it — the runtime bundle beside it still loads. Evaluated against
 * comment-stripped content with bare module markers removed, so the keyword
 * must come from an actual declaration. `declare` alone does not count: an
 * ambient `declare const x` without an export is not importable, so the
 * subpath would still resolve as a module with no API. Every declaration
 * target in the real distribution exports (verified across all 126 targets),
 * so requiring the keyword cannot misfire on legitimate output.
 */
const DECLARATION_SURFACE_PATTERN = /\bexport\b/;

/** Matches block and line comments for surface evaluation. */
const DECLARATION_COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Matches the surface-free module marker `export {};`. */
const BARE_MODULE_MARKER_PATTERN = /\bexport\s*\{\s*\}\s*;?/g;

/**
 * Reduces declaration content to the parts that can carry an API surface.
 * @param content - Raw declaration file content.
 * @returns Content without comments and bare `export {};` module markers.
 */
function stripSurfaceFreeContent(content: string): string {
  return content.replace(DECLARATION_COMMENT_PATTERN, '').replace(BARE_MODULE_MARKER_PATTERN, '');
}

/** Directory whose shipped declaration files are scanned for workspace imports. */
const DIST_DIRECTORY = 'dist';

/**
 * Matches the module specifier of a declaration file's top-level `import` and
 * `export … from` statements.
 *
 * Anchored at line start because that is where the declaration bundler emits
 * them, and because TSDoc `@example` blocks in the bundled output carry
 * indented `* import { … } from '@makaio/…';` lines that are documentation,
 * not module edges. `declare module '@makaio/…'` augmentation blocks are
 * likewise not matched: they augment a consumer-resolved module rather than
 * importing from it. The clause between the keyword and `from` excludes
 * quotes rather than newlines: a many-symbol import wrapped across lines is
 * still one module edge, while the quote exclusion keeps the lazy match from
 * ever jumping across another statement's specifier.
 */
const DECLARATION_IMPORT_SPECIFIER_PATTERN = /^(?:import|export)\b(?:[^'"]*?\bfrom)?\s*["']([^"']+)["']/gm;

/**
 * Matches the module specifier of an `import Foo = require("…")` statement.
 *
 * The import-equals form is legal in declaration files (typically `.d.cts`
 * output) and resolves its specifier exactly like an import statement does.
 * Line-anchored for the same reason as the import/export pattern: TSDoc
 * examples quoting the form are documentation, not module edges.
 */
const DECLARATION_IMPORT_EQUALS_PATTERN = /^import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/gm;

/**
 * Matches the package name of a `/// <reference types="…" />` directive.
 *
 * TypeScript resolves the referenced package while loading the declaration,
 * exactly like an import. Syntactically the directive is a line comment, so it
 * must be collected from raw content before comment stripping. `path="…"`
 * references are relative and therefore never name a package.
 */
const DECLARATION_REFERENCE_TYPES_PATTERN = /^\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/gm;

/**
 * Matches the module specifier of an inline `import("…")` type query.
 *
 * Declaration emitters may reference a foreign module without a top-level
 * import statement — `export type X = import("@makaio/…").Foo;` is legal
 * `.d.mts` output and forces consumers to resolve the specifier exactly like
 * an import statement does. Applied to comment-stripped content because TSDoc
 * prose may quote such queries as documentation.
 */
const DECLARATION_IMPORT_QUERY_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Matches workspace package specifiers that must never survive bundling. */
const WORKSPACE_SPECIFIER_PATTERN = /^@makaio\//;

/** Node builtin module names importable without the `node:` prefix. */
const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set(builtinModules);

/**
 * Validates the package-name part of a bare specifier. Anything minification
 * noise produces (template fragments, code excerpts) fails this shape check.
 */
const BARE_PACKAGE_NAME_PATTERN = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/;

/**
 * Extracts the package name from a bare external import specifier.
 * @param specifier - Import specifier found in a built module.
 * @returns The package name, or `undefined` when the specifier is relative,
 * absolute, a runtime builtin, or not a valid package specifier.
 */
export function toBarePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return undefined;

  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!BARE_PACKAGE_NAME_PATTERN.test(packageName)) return undefined;
  if (NODE_BUILTIN_MODULES.has(packageName)) return undefined;
  return packageName;
}

/**
 * Reports a declaration target that declares no API surface.
 * @param exportKey - Exports-map key the target belongs to.
 * @param target - Target path as written in the exports map.
 * @param resolvedTarget - Absolute path the target resolves to.
 * @param issues - Issue sink to append findings to.
 */
export function checkDeclarationSurface(
  exportKey: string,
  target: string,
  resolvedTarget: string,
  issues: FrameworkDistIssue[],
): void {
  if (DECLARATION_SURFACE_PATTERN.test(stripSurfaceFreeContent(readFileSync(resolvedTarget, 'utf8')))) return;

  issues.push({
    exportKey,
    kind: 'declaration-target-without-surface',
    message: `Framework export "${exportKey}" points at declaration file "${target}" that declares nothing — the subpath would resolve as an untyped module`,
    target,
  });
}

/**
 * Verifies that every import specifier in shipped declaration files resolves
 * for a consumer.
 *
 * Declaration imports are type-only edges: an erased edge never appears in the
 * `.mjs` output, so none of the runtime import scans observe it — this check
 * is the only thing standing between an unresolvable type import and a
 * shipped distribution. Three specifier classes are enforced:
 *
 * - **Workspace imports** (`@makaio/*` other than the published package) are
 *   always unresolvable: the declaration bundler must inline the type or
 *   rewrite the import to the published package's own subpath.
 * - **Self-imports** of the published package are allowed only when the
 *   exports map exposes the subpath: the bundler rewrites cross-entry type
 *   imports to the entry's umbrella subpath whether or not that subpath is
 *   public.
 * - **Bare externals** must be declared in the manifest (dependencies, peer,
 *   or optional): the runtime bundle may inline a package's code while its
 *   types stay external, so a consumer resolving the declaration needs the
 *   package installed even though the runtime never imports it.
 * @param root - Absolute framework package root.
 * @param packageName - Published package name whose self-imports are resolvable.
 * @param exportKeys - Normalized exports-map keys (e.g. `./storage/drizzle`).
 * @param declaredDependencies - Manifest-declared package names.
 * @param issues - Issue sink to append findings to.
 */
export function checkDeclarationImports(
  root: string,
  packageName: string | undefined,
  exportKeys: ReadonlySet<string>,
  declaredDependencies: ReadonlySet<string>,
  issues: FrameworkDistIssue[],
): void {
  const distPath = resolve(root, DIST_DIRECTORY);
  if (!existsSync(distPath)) return;

  for (const relativePath of readdirSync(distPath, { recursive: true, encoding: 'utf8' })) {
    if (!DECLARATION_TARGET_PATTERN.test(relativePath)) continue;

    const bundle = `${DIST_DIRECTORY}/${relativePath.replaceAll('\\', '/')}`;
    const content = readFileSync(resolve(distPath, relativePath), 'utf8');
    const specifiers = [
      ...[...content.matchAll(DECLARATION_IMPORT_SPECIFIER_PATTERN)].map((match) => match[1]),
      ...[...content.matchAll(DECLARATION_IMPORT_EQUALS_PATTERN)].map((match) => match[1]),
      ...[...content.matchAll(DECLARATION_REFERENCE_TYPES_PATTERN)].map((match) => match[1]),
      // Inline type queries carry no line anchor, so TSDoc examples are
      // excluded by stripping comments instead.
      ...[...stripSurfaceFreeContent(content).matchAll(DECLARATION_IMPORT_QUERY_PATTERN)].map((match) => match[1]),
    ];
    const reported = new Set<string>();
    for (const specifier of specifiers) {
      if (reported.has(specifier)) continue;
      if (!WORKSPACE_SPECIFIER_PATTERN.test(specifier)) {
        const externalName = toBarePackageName(specifier);
        if (externalName === undefined || declaredDependencies.has(externalName) || reported.has(externalName)) {
          continue;
        }

        reported.add(externalName);
        issues.push({
          exportKey: externalName,
          kind: 'undeclared-dist-dependency',
          message:
            `Declaration file "${bundle}" imports "${specifier}" but "${externalName}" is not declared in the ` +
            'framework manifest — the type-only edge never reaches the runtime import scan, and a consumer ' +
            'resolving the declaration needs the package installed',
          target: bundle,
        });
        continue;
      }
      if (packageName !== undefined && (specifier === packageName || specifier.startsWith(`${packageName}/`))) {
        const exportKey = specifier === packageName ? '.' : `./${specifier.slice(packageName.length + 1)}`;
        if (exportKeys.has(exportKey)) continue;

        reported.add(specifier);
        issues.push({
          exportKey,
          kind: 'unexported-dist-specifier',
          message:
            `Declaration file "${bundle}" imports "${specifier}" but the exports map has no "${exportKey}" ` +
            'entry — consumers of this declaration cannot resolve the rewritten type import',
          target: bundle,
        });
        continue;
      }

      reported.add(specifier);
      issues.push({
        exportKey: specifier,
        kind: 'unbundled-declaration-import',
        message:
          `Declaration file "${bundle}" imports "${specifier}" — workspace types must be inlined or rewritten ` +
          'to the published package, and consumers cannot resolve a workspace specifier',
        target: bundle,
      });
    }
  }
}

/** Declaration bundle that carries the core types. */
const CORE_DECLARATION_FILE = `${DIST_DIRECTORY}/core/index.d.mts`;

/** Directory whose declaration bundles must reuse the core types instead of declaring them. */
const BUS_DECLARATION_DIRECTORY = `${DIST_DIRECTORY}/bus`;

/** Matches the declaration bundler's top-level `export { … };` name lists. */
const DECLARATION_EXPORT_LIST_PATTERN = /^export\s*\{([^}]*)\}/gm;

/**
 * Matches a top-level declaration and captures the declared name. Anchored at
 * line start because that is where the declaration bundler emits top-level
 * declarations; members and TSDoc examples are indented.
 */
const DECLARATION_NAME_PATTERN =
  /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum|const|function|namespace)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Collects the names a declaration bundle exports through its `export { … }` lists.
 * @param content - Declaration bundle content.
 * @returns Exported names (the alias when a name is exported `as` another).
 */
function collectExportedNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const list of content.matchAll(DECLARATION_EXPORT_LIST_PATTERN)) {
    for (const entry of list[1].split(',')) {
      const name = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * Verifies that the bus declarations declare none of the core's exported types.
 *
 * The bus stage externalizes the core, so its declarations import core types
 * from the published core subpath. A bus declaration that declares a name the
 * core exports has re-inlined the core: consumers then see two declarations of
 * the same type, which TypeScript treats as unrelated (nominal members such as
 * private fields or `unique symbol` brands make the copies unassignable to each
 * other). Neither the import scan nor the surface check observes this.
 * @param root - Absolute framework package root.
 * @param issues - Issue sink to append findings to.
 */
export function checkBusDeclaresNoCoreTypes(root: string, issues: FrameworkDistIssue[]): void {
  const corePath = resolve(root, CORE_DECLARATION_FILE);
  const busPath = resolve(root, BUS_DECLARATION_DIRECTORY);
  if (!existsSync(corePath) || !existsSync(busPath)) return;

  const coreNames = collectExportedNames(readFileSync(corePath, 'utf8'));
  for (const relativePath of readdirSync(busPath, { recursive: true, encoding: 'utf8' })) {
    if (!DECLARATION_TARGET_PATTERN.test(relativePath)) continue;

    const bundle = `${BUS_DECLARATION_DIRECTORY}/${relativePath.replaceAll('\\', '/')}`;
    const content = readFileSync(resolve(busPath, relativePath), 'utf8');
    const reported = new Set<string>();
    for (const match of content.matchAll(DECLARATION_NAME_PATTERN)) {
      const name = match[1];
      if (!coreNames.has(name) || reported.has(name)) continue;

      reported.add(name);
      issues.push({
        exportKey: name,
        kind: 'bus-declares-core-type',
        message:
          `Declaration file "${bundle}" declares "${name}" which "${CORE_DECLARATION_FILE}" already exports — ` +
          'the bus declarations must import core types instead of inlining a second copy of the core',
        target: bundle,
      });
    }
  }
}

/** Runtime bundle that carries the core module. */
const CORE_RUNTIME_FILE = `${DIST_DIRECTORY}/core/index.mjs`;

/**
 * Matches the quoted string literals of a minified runtime module.
 *
 * Minified output mangles every local name and puts the whole module on one
 * line, so a defined function or class cannot be recognised by name; its string
 * literals survive verbatim. The scanner pairs quotes without tracking nesting,
 * so on template literals with `${}` substitutions it may pair the closing quote
 * of one literal with the opening quote of the next; {@link isFingerprintLiteral}
 * filters those code fragments out.
 */
const RUNTIME_STRING_LITERAL_PATTERN = /`(?:[^`\\$]|\\.|\$(?!\{))*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/** Shortest literal that identifies the core runtime rather than incidental text. */
const FINGERPRINT_MIN_LENGTH = 24;

/** Characters that mark a mis-paired quote span as code rather than a string literal. */
const CODE_FRAGMENT_PATTERN = /[;{}=]/;

/**
 * Tells whether a string literal body identifies the module it came from.
 * @param text - Literal body without its quotes.
 * @returns `true` for long literals that are prose, not mis-paired code.
 */
function isFingerprintLiteral(text: string): boolean {
  return text.length >= FINGERPRINT_MIN_LENGTH && !CODE_FRAGMENT_PATTERN.test(text);
}

/**
 * Verifies that no bus runtime module carries a copy of the core runtime.
 *
 * The bus stage externalizes the core, so its runtime modules import core
 * values from the published core subpath. Runtime and declarations are bundled
 * by separate passes, so a configuration change can re-inline the core's
 * runtime while the declarations stay external — nothing else observes it, yet
 * module-level state of the core (such as a registry that marks genuine
 * values) would then exist twice. The built output is minified, so the check
 * is marker-based: the long string literals of `dist/core/index.mjs` are its
 * fingerprint, and a bus module containing one of them has inlined core code.
 * This is a tripwire on literal-bearing core code in minified output, not a
 * proof of a single runtime copy; that is proven by the built-package test that
 * mints a call context through one entry and checks it through another. When
 * the core runtime yields no fingerprint the check cannot run, and it reports
 * that instead of passing silently.
 * @param root - Absolute framework package root.
 * @param issues - Issue sink to append findings to.
 */
export function checkBusBundlesNoCoreRuntime(root: string, issues: FrameworkDistIssue[]): void {
  const corePath = resolve(root, CORE_RUNTIME_FILE);
  const busPath = resolve(root, BUS_DECLARATION_DIRECTORY);
  if (!existsSync(corePath) || !existsSync(busPath)) return;

  const fingerprints = new Set<string>();
  for (const match of readFileSync(corePath, 'utf8').matchAll(RUNTIME_STRING_LITERAL_PATTERN)) {
    const text = match[0].slice(1, -1);
    if (isFingerprintLiteral(text)) fingerprints.add(text);
  }

  if (fingerprints.size === 0) {
    issues.push({
      exportKey: CORE_RUNTIME_FILE,
      kind: 'bus-bundles-core-runtime',
      message:
        `Core runtime "${CORE_RUNTIME_FILE}" yielded no string literal to fingerprint it by — the single-copy ` +
        'invariant of the core runtime is unverified',
      target: CORE_RUNTIME_FILE,
    });
    return;
  }

  for (const relativePath of readdirSync(busPath, { recursive: true, encoding: 'utf8' })) {
    if (!relativePath.endsWith('.mjs')) continue;

    const bundle = `${BUS_DECLARATION_DIRECTORY}/${relativePath.replaceAll('\\', '/')}`;
    const content = readFileSync(resolve(busPath, relativePath), 'utf8');
    for (const fingerprint of fingerprints) {
      if (!content.includes(fingerprint)) continue;

      issues.push({
        exportKey: fingerprint,
        kind: 'bus-bundles-core-runtime',
        message:
          `Runtime module "${bundle}" contains the core string literal "${fingerprint}" from "${CORE_RUNTIME_FILE}" — ` +
          'the bus runtime must import the core instead of inlining a second copy of it',
        target: bundle,
      });
    }
  }
}
