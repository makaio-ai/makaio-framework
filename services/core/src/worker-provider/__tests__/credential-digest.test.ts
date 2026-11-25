import { describe, expect, it } from 'vitest';
import {
  digestWorkerBootstrapToken,
  digestWorkerRuntimeSecret,
  matchesWorkerCredential,
} from '../credential-digest.js';

describe('worker credential digests', () => {
  // The SHA-256 input is the UTF-8 bytes of the purpose (without the colon),
  // one NUL byte (0x00), and the UTF-8 bytes of the credential value, in that
  // order. The stored string is the purpose, a colon, and the lowercase hex digest.
  it('uses different hash domains even for identical credential bytes', () => {
    const sample = 'example input';
    const bootstrap = digestWorkerBootstrapToken(sample);
    const runtime = digestWorkerRuntimeSecret(sample);

    expect(bootstrap).toBe('worker-bootstrap-v1:e065986136506eb4daabc992e5f19bb0df27afe327fcb74b4aab82b169e563f4');
    expect(runtime).toBe('worker-runtime-v1:f4ea92a027441ce8c22d2a7c383832b8175ac0eac56c808bd435f5ea07c3523d');
    expect(matchesWorkerCredential(bootstrap, bootstrap)).toBe(true);
    expect(matchesWorkerCredential(bootstrap, runtime)).toBe(false);
    expect(matchesWorkerCredential(bootstrap.replace('bootstrap', 'runtime'), runtime)).toBe(false);
  });

  it('refuses an unversioned, malformed, or absent digest', () => {
    const bootstrap = digestWorkerBootstrapToken('example input');

    expect(matchesWorkerCredential(bootstrap.slice(bootstrap.indexOf(':') + 1), bootstrap)).toBe(false);
    expect(matchesWorkerCredential(bootstrap.slice(0, -1), bootstrap)).toBe(false);
    expect(matchesWorkerCredential(undefined, bootstrap)).toBe(false);
  });
});
