#!/usr/bin/env tsx

/**
 * Generates framework Markdown documentation from analyzed bus namespace JSON.
 * @example
 * ```bash
 * tsx scripts/generate-bus-docs.ts --input docs/subjects/data/namespaces.json --out docs/subjects
 * ```
 */

import { runGenerateDocsCli } from './lib/namespace-analyzer/cli.js';
import { SUBJECT_DOCS_CONFIG } from './lib/subject-docs-surface.js';

runGenerateDocsCli(SUBJECT_DOCS_CONFIG);
