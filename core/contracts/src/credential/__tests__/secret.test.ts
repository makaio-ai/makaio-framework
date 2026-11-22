import { inspect } from 'node:util';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CredentialResolution } from '../resolution.js';
import { createSecret, isSecret, type Secret } from '../secret.js';

const VALUE = 'sk-distinctive-secret-value-7f3a9c';
const PLACEHOLDER = '[Secret]';

describe('Secret', () => {
  it('reveals the value it was created with', () => {
    expect(createSecret(VALUE).reveal()).toBe(VALUE);
  });

  it('throws a TypeError on JSON.stringify, alone and nested in an object or array', () => {
    const secret = createSecret(VALUE);
    const attempts = [
      () => JSON.stringify(secret),
      () => JSON.stringify({ nested: { secret } }),
      () => JSON.stringify([secret]),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(TypeError);
      try {
        attempt();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).not.toContain(VALUE);
        }
      }
    }
  });

  it('never yields the value through string conversion', () => {
    const secret = createSecret(VALUE);
    const conversions = [String(secret), `${secret}`, secret + '', secret.toString()];

    for (const converted of conversions) {
      expect(converted).toBe(PLACEHOLDER);
      expect(converted).not.toContain(VALUE);
    }
  });

  it('does not expose the value as a property', () => {
    const secret = createSecret(VALUE);
    const symbolValues = Object.getOwnPropertySymbols(secret).map((symbol) => Reflect.get(secret, symbol));
    const entryValues = Object.entries(secret).map(([, entry]) => entry);
    const exposed = [
      Object.keys(secret).join(','),
      Object.getOwnPropertyNames(secret).join(','),
      inspect(symbolValues),
      inspect(entryValues),
      inspect(secret, { showHidden: true, depth: 5 }),
    ];

    for (const text of exposed) {
      expect(text).not.toContain(VALUE);
    }
    expect(symbolValues).not.toContain(VALUE);
    expect(entryValues).not.toContain(VALUE);
  });

  it('is frozen', () => {
    const secret = createSecret(VALUE);

    expect(Object.isFrozen(secret)).toBe(true);
    expect(() => Object.assign(secret, { reveal: () => 'other' })).toThrow(TypeError);
    expect(() => Object.defineProperty(secret, 'reveal', { value: () => 'other' })).toThrow(TypeError);
    expect(secret.reveal()).toBe(VALUE);
  });

  it('isSecret accepts created secrets and rejects everything else', () => {
    const lookAlike = { reveal: () => VALUE, toJSON: () => undefined };

    expect(isSecret(createSecret(VALUE))).toBe(true);
    expect(isSecret(VALUE)).toBe(false);
    expect(isSecret(null)).toBe(false);
    expect(isSecret(undefined)).toBe(false);
    expect(isSecret({})).toBe(false);
    expect(isSecret(lookAlike)).toBe(false);
    expect(isSecret(42)).toBe(false);
  });

  it('recognizes a secret across module copies', () => {
    const brand = Symbol.for('@makaio/contracts.Secret');
    const methods = { reveal: () => VALUE, toJSON: () => undefined };
    const fromOtherCopy = { [brand]: true, ...methods };
    const sameDescriptionOnly = { [Symbol('@makaio/contracts.Secret')]: true, ...methods };

    expect(isSecret(fromOtherCopy)).toBe(true);
    expect(isSecret(sameDescriptionOnly)).toBe(false);
  });

  it('isSecret rejects a branded object that does not keep the contract', () => {
    const brand = Symbol.for('@makaio/contracts.Secret');

    expect(isSecret({ [brand]: true })).toBe(false);
    expect(isSecret({ [brand]: false, reveal: () => VALUE, toJSON: () => undefined })).toBe(false);
    expect(isSecret({ [brand]: true, reveal: VALUE, toJSON: () => undefined })).toBe(false);
    expect(isSecret({ [brand]: true, reveal: () => VALUE })).toBe(false);
  });

  it('cannot be cloned structurally', () => {
    let thrown: unknown;
    try {
      structuredClone(createSecret(VALUE));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.name : undefined).toBe('DataCloneError');
    expect(thrown instanceof Error ? thrown.message : VALUE).not.toContain(VALUE);
  });

  describe('CredentialResolution types', () => {
    it('narrows on success', () => {
      const narrow = (resolution: CredentialResolution<'not-found'>): void => {
        if (resolution.success) {
          expectTypeOf(resolution.value).toEqualTypeOf<Secret>();
        } else {
          expectTypeOf(resolution.error.code).toEqualTypeOf<'not-found'>();
        }
      };

      expect(typeof narrow).toBe('function');
    });
  });
});
