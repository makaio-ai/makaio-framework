/**
 * Analysis root and namespace-extraction configuration for the bus subject
 * documentation surface.
 *
 * This module intentionally stays light: it only resolves path constants and
 * declares extraction options, without importing the Markdown renderer or drift
 * detection machinery that `subject-docs-surface.ts` also owns. The analyzer CLI
 * (`scripts/analyze-bus-namespaces.ts`) needs only this module to extract namespaces
 * the same way the freshness gate does; pulling in the Markdown renderer for that
 * would be an unrelated, unnecessary dependency.
 * @packageDocumentation
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NamespaceExtractionOptions } from './namespace-analyzer/extract-namespaces.js';

const SCRIPTS_LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the analysis root whose tsconfig defines the documented source set. */
export const SUBJECT_DOCS_ANALYSIS_ROOT = resolve(SCRIPTS_LIB_DIR, '..', '..');

/**
 * Namespace-extraction options shared by the analyzer CLI and the freshness gate.
 *
 * Both consumers must extract namespaces from {@link SUBJECT_DOCS_ANALYSIS_ROOT} the
 * same way the committed pages were rendered, so this is the single place either side
 * defines exclusions, field expansions, or tier overrides for this documentation
 * surface.
 */
export const SUBJECT_DOCS_ANALYSIS_OPTIONS: NamespaceExtractionOptions = {};
