/**
 * The process-start gate must hold in the framework's own lint run.
 *
 * Every shipped source starts a process through `launch` from `@makaio/subprocess`;
 * a process-starting module or Bun API is refused outside the launcher package and
 * the listed exceptions. This file runs the framework's own config, the one a
 * standalone checkout of the framework uses.
 *
 * Asserted by **running the linter**, as the rehydrate guard's test does: a rule can
 * be present and inert (replaced by a later layer, mounted at paths that resolve
 * nowhere) while its source reads correctly. The probes are linted as if they sat at
 * a given path; the files need not exist.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROCESS_START_EXEMPT_FILES } from '../eslint-base.mjs';
import {
  frameworkRoot,
  lintProbe,
  PRIMITIVE_PROBE,
  RULE_ID,
  SPAWN_PROBE,
  START_PROBES,
  TYPE_PROBE,
} from './support/process-start-probes';

describe('process start guard in the framework config', () => {
  const probe = (source: string, path: string) => lintProbe(frameworkRoot, source, path);

  it.each(START_PROBES)('refuses a %s in an arbitrary src file', async (_way, source) => {
    expect(await probe(source, 'services/core/src/zz-guard-probe.ts')).toContain(RULE_ID);
  });

  it('refuses a process start in a .tsx src file', async () => {
    expect(await probe(SPAWN_PROBE, 'services/core/src/zz-guard-probe.tsx')).toContain(RULE_ID);
  });

  it('leaves a .test.tsx file alone', async () => {
    expect(await probe(SPAWN_PROBE, 'services/core/src/zz-guard-probe.test.tsx')).not.toContain(RULE_ID);
  });

  it('leaves the launcher package alone', async () => {
    expect(await probe(SPAWN_PROBE, 'packages/subprocess/src/zz-guard-probe.ts')).not.toContain(RULE_ID);
  });

  it('leaves a listed exception alone', async () => {
    expect(await probe(SPAWN_PROBE, 'packages/utils/src/keychain.ts')).not.toContain(RULE_ID);
  });

  it('does not refuse a type-only import', async () => {
    expect(await probe(TYPE_PROBE, 'services/core/src/zz-guard-probe.ts')).not.toContain(RULE_ID);
  });

  it('keeps the rehydrate restriction in services/core/src/session', async () => {
    expect(await probe(PRIMITIVE_PROBE, 'services/core/src/session/handlers/zz-guard-probe.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('refuses a process start in the session directory too', async () => {
    expect(await probe(SPAWN_PROBE, 'services/core/src/session/zz-guard-probe.ts')).toContain(RULE_ID);
  });

  it('leaves the sanctioned rehydrate importer alone for the primitive', async () => {
    expect(await probe(PRIMITIVE_PROBE, 'services/core/src/session/handlers/reserved-rehydrate.ts')).toEqual([]);
  });
});

describe('process start exemptions', () => {
  it('list only files that exist', () => {
    const missing = PROCESS_START_EXEMPT_FILES.filter((file) => !existsSync(resolve(frameworkRoot, file)));
    expect(missing).toEqual([]);
  });
});
