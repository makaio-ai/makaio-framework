#!/usr/bin/env tsx

/**
 * CLI entry point for the bus subject documentation freshness gate.
 *
 * Re-renders the committed pages under `docs/subjects/` in memory and exits with code 0
 * only when every committed page matches. Nothing is written to the working tree.
 *
 * Hosts that expose the regeneration under a different script name can override the
 * command named in the drift report with `--fix-command`. Hosts that run this gate from
 * a different root than the framework distribution root must override `--report-root`
 * so reported paths resolve from wherever the gate runs.
 * @example
 * ```bash
 * tsx scripts/validate-subject-docs.ts
 * tsx scripts/validate-subject-docs.ts --branch main
 * tsx scripts/validate-subject-docs.ts --fix-command 'yarn regenerate:docs'
 * tsx scripts/validate-subject-docs.ts --report-root framework/docs/subjects
 * ```
 * @packageDocumentation
 */

import { parseArgs } from 'node:util';

import {
  findSubjectDocDrift,
  formatSubjectDocDriftMessage,
  generateSubjectDocs,
  SUBJECT_DOCS_DIR_RELATIVE,
  type GeneratedSubjectDoc,
} from './lib/subject-docs-surface.js';

/** Regeneration command reported when the committed pages have drifted. */
const DEFAULT_FIX_COMMAND = 'yarn docs:bus';

const { values } = parseArgs({
  options: {
    branch: { type: 'string', short: 'b' },
    'fix-command': { type: 'string' },
    'report-root': { type: 'string' },
  },
  strict: true,
});

let files: GeneratedSubjectDoc[];
try {
  files = generateSubjectDocs(values.branch);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`subject-docs: analysis failed\n${message}`);
  process.exit(2);
}

const drift = findSubjectDocDrift(files);

if (drift.stale.length === 0 && drift.orphaned.length === 0) {
  console.info('subject-docs: up to date');
  process.exit(0);
}

console.error(
  formatSubjectDocDriftMessage(
    drift,
    values['fix-command'] ?? DEFAULT_FIX_COMMAND,
    values['report-root'] ?? SUBJECT_DOCS_DIR_RELATIVE,
  ),
);
process.exit(1);
