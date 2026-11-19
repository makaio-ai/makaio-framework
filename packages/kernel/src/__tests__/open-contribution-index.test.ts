import { describe, expect, it } from 'vitest';
import { OpenContributionIndex } from '../extension/open-contribution-index.js';

describe('OpenContributionIndex', () => {
  describe('activate', () => {
    it('rejects a key that is not a contribution name', () => {
      const index = new OpenContributionIndex();

      expect(() => index.activate('acme', { widgets: [] })).toThrow(/not a contribution name/);
    });

    it('rejects a value that is not an array', () => {
      const index = new OpenContributionIndex();
      const slot = JSON.parse('{"acme.widgets": {"id": "w"}}');

      expect(() => index.activate('acme', slot)).toThrow(/of extension 'acme' must be an array/);
    });

    it('stores nothing from a slot that fails validation', () => {
      const index = new OpenContributionIndex();
      const slot = JSON.parse('{"acme.widgets": [{"id": "w"}], "acme.broken": "no"}');

      expect(() => index.activate('acme', slot)).toThrow();

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([]);
    });

    it('keeps the earlier slot when a re-activation fails', () => {
      const index = new OpenContributionIndex();
      index.activate('acme', { 'acme.widgets': [{ id: 'old' }] });

      expect(() => index.activate('acme', { 'acme.widgets': [{ id: 'new' }], bad: [] })).toThrow();

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([{ extension: 'acme', entries: [{ id: 'old' }] }]);
    });

    it.each([
      ['null', null],
      ['0', 0],
      ['true', true],
      ['an empty array', []],
      ['an empty string', ''],
      ['a string', 'x'],
      ['a non-empty array', ['a']],
      ['a Map', new Map([['acme.widgets', [{ id: 'w' }]]])],
    ])('rejects a slot that is %s and keeps the earlier slot', (_label, slot: unknown) => {
      const index = new OpenContributionIndex();
      index.activate('acme', { 'acme.widgets': [{ id: 'old' }] });

      expect(() => index.activate('acme', slot)).toThrow(
        "Open contributions of extension 'acme' must be an object keyed by contribution name",
      );

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([{ extension: 'acme', entries: [{ id: 'old' }] }]);
    });

    it('accepts an extension without a slot', () => {
      const index = new OpenContributionIndex();

      index.activate('acme', undefined);

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([]);
    });
  });

  describe('readerFor', () => {
    it('returns the entries of every contributor to a kind owned by the reader', () => {
      const index = new OpenContributionIndex();
      index.activate('plugin', { 'acme.widgets': [{ id: 'w1' }, { id: 'w2' }] });

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([
        { extension: 'plugin', entries: [{ id: 'w1' }, { id: 'w2' }] },
      ]);
    });

    it('skips contributors that have no entries for the kind', () => {
      const index = new OpenContributionIndex();
      index.activate('plugin', { 'acme.gadgets': [{ id: 'g' }] });

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([]);
    });

    it('throws when the kind is not owned by the reader', () => {
      const index = new OpenContributionIndex();
      index.activate('plugin', { 'acme.widgets': [{ id: 'w' }] });

      expect(() => index.readerFor('other').of('acme.widgets')).toThrow(/does not own contribution kind/);
    });

    it('lets an owner with dots read its kinds', () => {
      const index = new OpenContributionIndex();
      index.activate('plugin', { 'makaio.clients-core.hooks': [{ id: 'h' }] });

      expect(index.readerFor('makaio.clients-core').of('makaio.clients-core.hooks')).toEqual([
        { extension: 'plugin', entries: [{ id: 'h' }] },
      ]);
      expect(() => index.readerFor('makaio').of('makaio.hooks')).not.toThrow();
    });

    it('lets an npm-scoped owner read its kinds', () => {
      const index = new OpenContributionIndex();
      index.activate('plugin', { '@acme/review.checks': [{ id: 'c' }] });

      expect(index.readerFor('@acme/review').of('@acme/review.checks')).toEqual([
        { extension: 'plugin', entries: [{ id: 'c' }] },
      ]);
      expect(() => index.readerFor('@acme/other').of('@acme/review.checks')).toThrow();
    });

    it('returns contributors in activation order', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [{ id: 'a' }] });
      index.activate('second', { 'acme.widgets': [{ id: 'b' }] });

      expect(
        index
          .readerFor('acme')
          .of('acme.widgets')
          .map((set) => set.extension),
      ).toEqual(['first', 'second']);
    });

    it('moves a re-activated extension to the end and replaces its slot', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [{ id: 'a' }] });
      index.activate('second', { 'acme.widgets': [{ id: 'b' }] });
      index.activate('first', { 'acme.widgets': [{ id: 'a2' }] });

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([
        { extension: 'second', entries: [{ id: 'b' }] },
        { extension: 'first', entries: [{ id: 'a2' }] },
      ]);
    });

    it('returns frozen results that a later activation does not change', () => {
      const index = new OpenContributionIndex();
      const reader = index.readerFor('acme');
      index.activate('first', { 'acme.widgets': [{ id: 'a' }] });

      const before = reader.of('acme.widgets');
      index.activate('second', { 'acme.widgets': [{ id: 'b' }] });
      const after = reader.of('acme.widgets');

      expect(before.map((set) => set.extension)).toEqual(['first']);
      expect(after.map((set) => set.extension)).toEqual(['first', 'second']);
      expect(Object.isFrozen(before)).toBe(true);
      expect(Object.isFrozen(before[0])).toBe(true);
      expect(Object.isFrozen(before[0]?.entries)).toBe(true);
    });

    it('copies the entries so that later changes to the slot array do not show', () => {
      const index = new OpenContributionIndex();
      const entries = [{ id: 'a' }];
      index.activate('first', { 'acme.widgets': entries });
      entries.push({ id: 'late' });

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([{ extension: 'first', entries: [{ id: 'a' }] }]);
    });
  });

  describe('deactivate', () => {
    it('removes the entries of the extension only', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [{ id: 'a' }] });
      index.activate('second', { 'acme.widgets': [{ id: 'b' }] });

      index.deactivate('first');

      expect(index.readerFor('acme').of('acme.widgets')).toEqual([{ extension: 'second', entries: [{ id: 'b' }] }]);
    });

    it('ignores an extension that is not active', () => {
      const index = new OpenContributionIndex();

      expect(() => index.deactivate('ghost')).not.toThrow();
    });
  });

  describe('unclaimedKinds', () => {
    it('lists kinds whose owner is not active, each once', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [{ id: 'a' }], 'beta.gadgets': [{ id: 'g' }] });
      index.activate('second', { 'acme.widgets': [{ id: 'b' }] });

      expect(index.unclaimedKinds(['beta'])).toEqual(['acme.widgets']);
    });

    it('returns nothing when every owner is active', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [{ id: 'a' }] });

      expect(index.unclaimedKinds(['acme'])).toEqual([]);
    });

    it('ignores kinds without entries', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [] });

      expect(index.unclaimedKinds([])).toEqual([]);
    });

    it('treats any dot-delimited prefix as a candidate owner', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'makaio.clients-core.hooks': [{ id: 'h' }] });

      expect(index.unclaimedKinds(['makaio.clients-core'])).toEqual([]);
      expect(index.unclaimedKinds(['makaio'])).toEqual([]);
      expect(index.unclaimedKinds(['other'])).toEqual(['makaio.clients-core.hooks']);
    });

    it('stops listing a kind once its contributors are deactivated', () => {
      const index = new OpenContributionIndex();
      index.activate('first', { 'acme.widgets': [{ id: 'a' }] });
      index.deactivate('first');

      expect(index.unclaimedKinds([])).toEqual([]);
    });
  });

  // Open question (FACT-383, extension `a` next to extension `a.b`): the owner may contain dots, so `a`
  // counts as owner of `a.b.widgets`. This pins today's behaviour; it is not a decision.
  describe('extension `a` next to extension `a.b`', () => {
    it('lets `a` read the kind of `a.b` and counts the kind as claimed by `a`', () => {
      const index = new OpenContributionIndex();
      index.activate('plugin', { 'a.b.widgets': [{ id: 'w' }] });

      expect(index.readerFor('a').of('a.b.widgets')).toEqual([{ extension: 'plugin', entries: [{ id: 'w' }] }]);
      expect(index.readerFor('a.b').of('a.b.widgets')).toEqual([{ extension: 'plugin', entries: [{ id: 'w' }] }]);
      expect(index.unclaimedKinds(['a'])).toEqual([]);
    });
  });
});
