/**
 * The rehydrate-producer gate must hold in this repository's own lint run.
 *
 * The rule is a boundary rule: it names the one sanctioned producer of
 * `adapter.rehydrateAgent` and refuses every other. A gate that only exists in
 * the config of a host that composes these sources leaves this checkout — the
 * one a new producer is written and validated in — ungated, which is the one
 * place it has to hold.
 *
 * Asserted by **running the linter**, against this repository's own config and
 * from its own root, rather than by matching the config's source. A rule can be
 * present and inert — mounted with paths that resolve nowhere here, or replaced
 * for these files by a later layer under flat-config last-wins — and every one
 * of those states reads correctly in the source while reporting nothing on a
 * file. Two probes, one per half of the gate, plus the sanctioned end that must
 * stay silent.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** This repository's root, which is also the root its config is written for. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A producer that reaches the subject the sanctioned rehydrate owns. */
const SUBJECT_PROBE = [
  "import { AdapterSubjects } from '@makaio/contracts';",
  'export const probe = AdapterSubjects.rehydrateAgent;',
].join('\n');

/** A caller that reaches the raw dispatch primitive by relative path. */
const PRIMITIVE_PROBE = [
  "import { dispatchAgentRehydrate } from './rehydrate-dispatch.js';",
  'export const probe = dispatchAgentRehydrate;',
].join('\n');

/**
 * Lint one probe as if it were a file at the given path in this repository.
 *
 * The path decides everything this gate is about — which layers match, which
 * exemptions apply — so it is the input under test, and the file itself need
 * not exist.
 * @param source - Probe source to lint.
 * @param relativePath - Path the probe is linted as, from this repository's root.
 * @returns The rule IDs that reported on it.
 */
async function lintProbe(source: string, relativePath: string): Promise<Array<string | null>> {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: resolve(repoRoot, 'eslint.config.mjs'),
    warnIgnored: false,
  });
  const [result] = await eslint.lintText(source, { filePath: resolve(repoRoot, relativePath) });
  return result?.messages.map((message) => message.ruleId) ?? [];
}

describe('rehydrate producer guard', () => {
  const producerPath = 'services/core/src/session/handlers/zz-guard-probe.ts';

  it('refuses a second producer of the rehydrate subject', async () => {
    expect(await lintProbe(SUBJECT_PROBE, producerPath)).toContain('no-restricted-syntax');
  });

  it('refuses a caller that reaches the dispatch primitive', async () => {
    expect(await lintProbe(PRIMITIVE_PROBE, producerPath)).toContain('no-restricted-imports');
  });

  it('leaves the one sanctioned importer of the primitive alone', async () => {
    // The other half of a working gate, and the half a wrong mount breaks in
    // the opposite direction just as silently: exemptions that resolve nowhere
    // would report the sanctioned end as a violation.
    const sanctioned = await lintProbe(PRIMITIVE_PROBE, 'services/core/src/session/handlers/reserved-rehydrate.ts');
    expect(sanctioned).toEqual([]);
  });
});
