/**
 * Re-exports framework import-rewriting utilities for the Electrobun build.
 *
 * The canonical implementations live in `@makaio/build-tooling/framework-import-map`.
 * This module provides Electrobun-specific aliases and keeps existing test
 * import paths stable.
 * @packageDocumentation
 */

export {
  frameworkExternalPackageNames,
  rewriteFrameworkImportSpecifier as rewriteToFrameworkSubpath,
  rewriteFrameworkImportsInText as rewriteFrameworkImportsInBundle,
} from '@makaio/build-tooling/framework-import-map';
