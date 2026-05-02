#!/usr/bin/env tsx

/**
 * Analyzes framework bus namespace registrations and writes structured JSON
 * output with paths relative to the framework distribution root.
 * @example
 * ```bash
 * tsx scripts/analyze-bus-namespaces.ts --out docs/subjects/data/namespaces.json --summary
 * ```
 */

import { dirname, resolve } from 'node:path';

import { runAnalyzeNamespacesCli } from './lib/namespace-analyzer/cli.js';

const ROOT = dirname(import.meta.dirname);

runAnalyzeNamespacesCli({ root: resolve(ROOT) });
