#!/usr/bin/env tsx

/**
 * Generates framework Markdown documentation from analyzed bus namespace JSON.
 * @example
 * ```bash
 * tsx scripts/generate-bus-docs.ts --input docs/subjects/data/namespaces.json --out docs/subjects
 * ```
 */

import { runGenerateDocsCli } from './lib/namespace-analyzer/cli.js';

runGenerateDocsCli({
  title: 'Bus Subject Namespaces (Framework)',
  sourceRoot: '',
  includeTiers: ['framework', 'extension'],
  includeProductCallsites: false,
});
