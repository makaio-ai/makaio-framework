import { describe, it, expect } from 'vitest';
import { isExtensionManifestLike, normalizeExtensionManifestExport } from '../normalize-extension-export.js';

const DESCRIPTOR = 'acme.widgets';

// Real manifest-like package carrying the identity fields the function checks.
function pkg(name: string): { name: string; displayName: string; version: string } {
  return { name, displayName: name, version: '1.0.0' };
}

// Runs the function and collects every `onInvalid` reason it reports.
function run(value: unknown, descriptorName: string = DESCRIPTOR) {
  const reasons: string[] = [];
  const result = normalizeExtensionManifestExport(value, descriptorName, (reason) => reasons.push(reason));
  return { result, reasons };
}

const OUTSIDE_TEXT = `default export array contains package names outside descriptor namespace '${DESCRIPTOR}', skipping`;

describe('isExtensionManifestLike', () => {
  it('accepts objects with name, displayName and version', () => {
    expect(isExtensionManifestLike(pkg(DESCRIPTOR))).toBe(true);
  });

  it('rejects null and objects without identity fields', () => {
    expect(isExtensionManifestLike(null)).toBe(false);
    expect(isExtensionManifestLike({ name: DESCRIPTOR })).toBe(false);
  });
});

describe('normalizeExtensionManifestExport', () => {
  it('accepts a single object matching the descriptor name', () => {
    const value = pkg(DESCRIPTOR);
    const { result, reasons } = run(value);
    expect(result).toEqual([value]);
    expect(reasons).toEqual([]);
  });

  it('rejects a single object with another name', () => {
    const { result, reasons } = run(pkg('acme.other'));
    expect(result).toBeUndefined();
    expect(reasons).toEqual([
      `imported package name 'acme.other' does not match descriptor name '${DESCRIPTOR}', skipping`,
    ]);
  });

  it('rejects a single value that is not manifest-like', () => {
    const { result, reasons } = run({ name: DESCRIPTOR });
    expect(result).toBeUndefined();
    expect(reasons).toEqual(['default export is not a valid MakaioExtension or MakaioExtension[], skipping']);
  });

  it('accepts an array with the descriptor package and a child package', () => {
    const value = [pkg(DESCRIPTOR), pkg(`${DESCRIPTOR}.child`)];
    const { result, reasons } = run(value);
    expect(result).toEqual(value);
    expect(reasons).toEqual([]);
  });

  it('accepts a descriptor with dots and an npm-scoped descriptor with children', () => {
    expect(run([pkg('@acme/review'), pkg('@acme/review.child')], '@acme/review').result).toHaveLength(2);
  });

  it('rejects an array with a package outside the namespace', () => {
    const { result, reasons } = run([pkg(DESCRIPTOR), pkg('acme.other')]);
    expect(result).toBeUndefined();
    expect(reasons).toEqual([OUTSIDE_TEXT]);
  });

  it('rejects a prefix-matching variant of the descriptor name', () => {
    const { result, reasons } = run([pkg(DESCRIPTOR), pkg(`${DESCRIPTOR}x.child`)]);
    expect(result).toBeUndefined();
    expect(reasons).toEqual([OUTSIDE_TEXT]);
  });

  it('rejects a package named exactly `<descriptor>.` (empty local part)', () => {
    const { result, reasons } = run([pkg(DESCRIPTOR), pkg(`${DESCRIPTOR}.`)]);
    expect(result).toBeUndefined();
    expect(reasons).toEqual([OUTSIDE_TEXT]);
  });

  it('rejects duplicate package names', () => {
    const { result, reasons } = run([pkg(DESCRIPTOR), pkg(`${DESCRIPTOR}.child`), pkg(`${DESCRIPTOR}.child`)]);
    expect(result).toBeUndefined();
    expect(reasons).toEqual([`default export array contains duplicate package name '${DESCRIPTOR}.child', skipping`]);
  });

  it('rejects an array without the descriptor package', () => {
    const { result, reasons } = run([pkg(`${DESCRIPTOR}.child`)]);
    expect(result).toBeUndefined();
    expect(reasons).toEqual([
      `default export array must include a package named '${DESCRIPTOR}' to match descriptor identity, skipping`,
    ]);
  });

  it('rejects an array containing an invalid element', () => {
    const { result, reasons } = run([pkg(DESCRIPTOR), { name: 'broken' }]);
    expect(result).toBeUndefined();
    expect(reasons).toEqual(['default export array contains an invalid MakaioExtension, skipping']);
  });
});
