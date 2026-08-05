/**
 * What `frameworkCorePackages` obliges a host to compose alongside it.
 *
 * The set is independent of host-specific *factories*, which is not the same as
 * self-contained: two members declare packages that live in sets depending on
 * this one, so they cannot be members and the array has never loaded on its own.
 * That is a contract, not a defect — but it is the kind of contract that is
 * discovered at boot unless something states it.
 *
 * These cases state it. The valuable one is the last: a *new* member reaching
 * outside the set fails here, where the fix is cheap, instead of at a host's
 * first start.
 */
import { describe, expect, it } from 'vitest';
import { ADAPTER_SUBSYSTEM_PACKAGE_NAME } from '../adapter-subsystem/namespace.js';
import { canonicalModelPackage, frameworkCorePackages } from '../index.js';

/**
 * Dependencies a host is expected to satisfy from a sibling set.
 *
 * Each entry is a package that depends on `@makaio/services-core` and therefore
 * cannot be named in its package list. Adding to this list is a decision about
 * what a host must compose — not a way to quiet the case below.
 */
const COMPOSED_BY_THE_HOST: ReadonlyArray<string> = [
  // Registers the adapter subsystem service the canonical-model service awaits.
  ADAPTER_SUBSYSTEM_PACKAGE_NAME,
  // Registers the client runtime the account-linking service resolves against.
  'makaio.clients-core',
];

describe('frameworkCorePackages', () => {
  it('carries the canonical-model package, whose subsystem the host composes', () => {
    // Kept in the set: every host that composes it also composes the adapter
    // subsystem, and dropping it would silently remove the service from any
    // host that takes its framework packages from here.
    expect(frameworkCorePackages).toContain(canonicalModelPackage);
    expect(canonicalModelPackage.dependencies?.map((declared) => declared.name)).toContain(
      ADAPTER_SUBSYSTEM_PACKAGE_NAME,
    );
    expect(frameworkCorePackages.map((pkg) => pkg.name)).not.toContain(ADAPTER_SUBSYSTEM_PACKAGE_NAME);
  });

  it('reaches outside itself only for the dependencies a host is told to compose', () => {
    const provided = new Set(frameworkCorePackages.map((pkg) => pkg.name));
    const external = new Set<string>();
    for (const pkg of frameworkCorePackages) {
      for (const declared of pkg.dependencies ?? []) {
        if (!provided.has(declared.name)) external.add(declared.name);
      }
    }

    // An unexpected name here means a new member depends on something no host
    // has been told to bring, and the coordinator will refuse the load set at
    // startup with nothing pointing at the cause.
    expect([...external].sort()).toEqual([...COMPOSED_BY_THE_HOST].sort());
  });
});
