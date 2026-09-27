import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createInstalledFrameworkTarballProvider,
  INSTALLED_PACKAGE_SUITES,
  requiresInstalledFrameworkTarball,
} from './installed-package-tarball.global-setup.js';

const suite = join(import.meta.dirname, INSTALLED_PACKAGE_SUITES[0]);
const unrelated = join(import.meta.dirname, 'build-staging.test.ts');

describe('installed framework tarball global setup selection', () => {
  it('lists only existing suites', () => {
    for (const listed of INSTALLED_PACKAGE_SUITES) {
      expect(existsSync(join(import.meta.dirname, listed)), listed).toBe(true);
    }
  });

  it('builds only when an installed-package suite is selected', () => {
    expect(requiresInstalledFrameworkTarball([unrelated, suite])).toBe(true);
    expect(requiresInstalledFrameworkTarball([unrelated])).toBe(false);
    expect(requiresInstalledFrameworkTarball([])).toBe(false);
  });

  it('rebuilds once per relevant run, replaces the previous tarball, and ignores unrelated reruns', async () => {
    const build = vi.fn(async (root: string) => {
      const tarball = join(root, 'framework.tgz');
      await writeFile(tarball, '');
      return tarball;
    });
    const provided: string[] = [];
    const provider = createInstalledFrameworkTarballProvider(build, (tarball) => provided.push(tarball));

    await provider.refresh([unrelated]);
    expect(build).not.toHaveBeenCalled();

    await provider.refresh([suite, unrelated]);
    await provider.refresh([unrelated]);
    expect(build).toHaveBeenCalledTimes(1);
    const [initial] = provided;
    expect(existsSync(initial)).toBe(true);

    await provider.refresh([suite]);
    expect(build).toHaveBeenCalledTimes(2);
    const rebuilt = provided[1];
    expect(rebuilt).not.toBe(initial);
    expect(existsSync(dirname(initial))).toBe(false);
    expect(existsSync(rebuilt)).toBe(true);

    await provider.dispose();
    expect(existsSync(dirname(rebuilt))).toBe(false);
  });

  it('removes the build directory when a rebuild fails', async () => {
    let failedRoot = '';
    const provider = createInstalledFrameworkTarballProvider(
      (root) => {
        failedRoot = root;
        return Promise.reject(new Error('build failed'));
      },
      () => undefined,
    );
    await expect(provider.refresh([suite])).rejects.toThrow('build failed');
    expect(existsSync(failedRoot)).toBe(false);
  });
});
