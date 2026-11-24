import { describe, expect, it } from 'vitest';
import { ContributionRegistryCore } from '../contribution-registry-core.js';

/** Minimal registered entry used by these tests: just a name. */
interface Entry {
  readonly name: string;
}

/**
 * Builds a core instance over {@link Entry}, labelled for error-message assertions.
 * @returns A fresh core with no registered entries.
 */
function makeCore(): ContributionRegistryCore<Entry> {
  return new ContributionRegistryCore<Entry>({ label: 'Widget', nameOf: (entry) => entry.name });
}

describe('ContributionRegistryCore', () => {
  describe('namespace and owner checks', () => {
    it('rejects a name outside the owning extension namespace', () => {
      const core = makeCore();
      expect(() => core.validateBatch('alpha', [{ name: 'other.thing' }])).toThrow(
        "Widget 'other.thing' must be namespaced by extension 'alpha.'",
      );
    });

    it('rejects the bare extension prefix with no local name', () => {
      const core = makeCore();
      expect(() => core.validateBatch('alpha', [{ name: 'alpha.' }])).toThrow(
        "Widget 'alpha.' must be namespaced by extension 'alpha.'",
      );
    });

    it('rejects a noncanonical name inside the owning extension namespace', () => {
      const core = makeCore();

      expect(() => core.validateBatch('alpha', [{ name: 'alpha.notify.' }])).toThrow(TypeError);
    });

    it('rejects an in-batch name collision', () => {
      const core = makeCore();
      expect(() => core.validateBatch('alpha', [{ name: 'alpha.a' }, { name: 'alpha.a' }])).toThrow(
        "Widget name collision: 'alpha.a' appears twice in batch from 'alpha'",
      );
    });

    it('rejects a name already owned by a different extension', () => {
      // The default ownership predicate ties a name's prefix to its only
      // possible owner, so no name can ever pass that check for a second
      // owner — the collision this exercises needs an ownership predicate
      // that two different owners can both satisfy for the same name (here,
      // one that admits every name for every owner), so the cross-owner
      // collision check is reached instead of being pre-empted by the
      // namespace check.
      const core = new ContributionRegistryCore<Entry>({
        label: 'Widget',
        nameOf: (entry) => entry.name,
        ownsName: () => true,
      });
      core.validateBatch('alpha', [{ name: 'shared.thing' }]);
      core.commitBatch('alpha', [{ name: 'shared.thing' }]);

      expect(() => core.validateBatch('beta', [{ name: 'shared.thing' }])).toThrow(
        "Widget name collision: 'shared.thing' is already registered",
      );
    });

    it('allows a batch to re-declare the same owner current names', () => {
      const core = makeCore();
      core.validateBatch('alpha', [{ name: 'alpha.a' }]);
      core.commitBatch('alpha', [{ name: 'alpha.a' }]);

      expect(() => core.validateBatch('alpha', [{ name: 'alpha.a' }])).not.toThrow();
    });

    it('supports a custom ownership predicate for a name that equals the owner itself', () => {
      const core = new ContributionRegistryCore<Entry>({
        label: 'Rule block',
        nameOf: (entry) => entry.name,
        ownsName: (owner, name) => name === owner,
      });

      expect(() => core.validateBatch('alpha', [{ name: 'alpha' }])).not.toThrow();
      expect(() => core.validateBatch('alpha', [{ name: 'alpha.sub' }])).toThrow(
        "Rule block 'alpha.sub' must be namespaced by extension 'alpha.'",
      );
    });
  });

  describe('all-or-nothing batch commit', () => {
    it('leaves no partial registration when validateBatch rejects a batch', () => {
      const core = makeCore();
      expect(() => core.validateBatch('alpha', [{ name: 'alpha.a' }, { name: 'other.b' }])).toThrow();

      expect(core.list()).toEqual([]);
      expect(core.get('alpha.a')).toBeUndefined();
    });

    it('commits every entry of a validated batch together', () => {
      const core = makeCore();
      const batch = [{ name: 'alpha.a' }, { name: 'alpha.b' }];
      core.validateBatch('alpha', batch);
      core.commitBatch('alpha', batch);

      expect(
        core
          .list()
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(['alpha.a', 'alpha.b']);
      expect(core.get('alpha.a')).toBe(batch[0]);
      expect(core.get('alpha.b')).toBe(batch[1]);
    });

    it('atomically replaces a prior batch with a new one from the same owner', () => {
      const core = makeCore();
      core.validateBatch('alpha', [{ name: 'alpha.a' }]);
      core.commitBatch('alpha', [{ name: 'alpha.a' }]);

      const replacement = [{ name: 'alpha.b' }];
      core.validateBatch('alpha', replacement);
      core.commitBatch('alpha', replacement);

      expect(core.list().map((entry) => entry.name)).toEqual(['alpha.b']);
      expect(core.get('alpha.a')).toBeUndefined();
    });
  });

  describe('removal on stop', () => {
    it('removes every entry of an owner when committing an empty batch', () => {
      const core = makeCore();
      core.validateBatch('alpha', [{ name: 'alpha.a' }, { name: 'alpha.b' }]);
      core.commitBatch('alpha', [{ name: 'alpha.a' }, { name: 'alpha.b' }]);
      core.validateBatch('beta', [{ name: 'beta.c' }]);
      core.commitBatch('beta', [{ name: 'beta.c' }]);

      core.commitBatch('alpha', []);

      expect(core.list().map((entry) => entry.name)).toEqual(['beta.c']);
      expect(core.ownerBatch('alpha')).toBeUndefined();
    });

    it('is a no-op when removing an owner with no registrations', () => {
      const core = makeCore();
      const index = core.nameIndex;

      core.commitBatch('alpha', []);

      expect(core.nameIndex).toBe(index);
    });

    it('frees a name for a different owner once its original owner is removed', () => {
      const core = makeCore();
      core.validateBatch('alpha', [{ name: 'alpha.a' }]);
      core.commitBatch('alpha', [{ name: 'alpha.a' }]);
      core.commitBatch('alpha', []);

      expect(() => core.validateBatch('alpha', [{ name: 'alpha.a' }])).not.toThrow();
    });

    it('clear() removes every owner and every name', () => {
      const core = makeCore();
      core.validateBatch('alpha', [{ name: 'alpha.a' }]);
      core.commitBatch('alpha', [{ name: 'alpha.a' }]);

      core.clear();

      expect(core.list()).toEqual([]);
      expect(core.ownerBatch('alpha')).toBeUndefined();
    });
  });

  describe('nameIndex identity', () => {
    it('publishes a new index on every committed mutation', () => {
      const core = makeCore();
      const before = core.nameIndex;
      core.validateBatch('alpha', [{ name: 'alpha.a' }]);
      core.commitBatch('alpha', [{ name: 'alpha.a' }]);

      expect(core.nameIndex).not.toBe(before);
    });
  });
});
