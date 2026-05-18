import { describe, expect, it } from 'vitest';
import type { ESLint } from 'eslint';
import { ValidatorContext } from '../util/validator-context.js';
import { validateESLint } from './eslint-validator.js';

describe('validateESLint', () => {
  it('passes the requested cache setting and cache location to ESLint', async () => {
    let options: ESLint.Options | undefined;

    class FakeESLint {
      public constructor(nextOptions: ESLint.Options) {
        options = nextOptions;
      }

      public async isPathIgnored(): Promise<boolean> {
        return true;
      }
    }

    await validateESLint(
      ['/tmp/example.ts'],
      FakeESLint as unknown as typeof ESLint,
      new ValidatorContext({}),
      false,
      false,
    );

    expect(options).toMatchObject({
      cache: false,
      cacheLocation: '.eslintcache',
      fix: false,
    });
  });
});
