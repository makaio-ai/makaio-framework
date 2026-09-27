import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSTALLED_PACKAGE_SUITES,
  requiresInstalledFrameworkTarball,
} from './installed-package-tarball.global-setup.js';

describe('installed framework tarball global setup selection', () => {
  it('lists only existing suites', () => {
    for (const suite of INSTALLED_PACKAGE_SUITES) {
      expect(existsSync(join(import.meta.dirname, suite)), suite).toBe(true);
    }
  });

  it('builds only when an installed-package suite is selected', () => {
    const suite = join(import.meta.dirname, INSTALLED_PACKAGE_SUITES[0]);
    const unrelated = join(import.meta.dirname, 'build-staging.test.ts');
    expect(requiresInstalledFrameworkTarball([unrelated, suite])).toBe(true);
    expect(requiresInstalledFrameworkTarball([unrelated])).toBe(false);
    expect(requiresInstalledFrameworkTarball([])).toBe(false);
  });
});
