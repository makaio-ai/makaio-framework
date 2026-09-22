#!/usr/bin/env tsx

/**
 * Analyzes framework bus namespace registrations and writes structured JSON
 * output with paths relative to the framework distribution root.
 * @example
 * ```bash
 * tsx scripts/analyze-bus-namespaces.ts --out docs/subjects/data/namespaces.json --summary
 * ```
 */

import { runAnalyzeNamespacesCli } from './lib/namespace-analyzer/cli.js';
import { SUBJECT_DOCS_ANALYSIS_OPTIONS, SUBJECT_DOCS_ANALYSIS_ROOT } from './lib/subject-docs-analysis-config.js';

runAnalyzeNamespacesCli({
  root: SUBJECT_DOCS_ANALYSIS_ROOT,
  namespaceExcludePathPrefixes: SUBJECT_DOCS_ANALYSIS_OPTIONS.excludePathPrefixes,
  subjectFieldTypeExpansions: SUBJECT_DOCS_ANALYSIS_OPTIONS.subjectFieldTypeExpansions,
  classifyNamespaceTier: SUBJECT_DOCS_ANALYSIS_OPTIONS.classifyNamespaceTier,
});
