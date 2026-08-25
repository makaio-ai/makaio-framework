import { expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { JsonValue } from '../../shared/json-value.js';
import { CodeExecutionRequestSchema } from '../schemas.js';

it('keeps JSON-bearing request fields typed for callers', () => {
  type RequestInput = z.input<typeof CodeExecutionRequestSchema>;

  expectTypeOf<RequestInput['arguments']>().toEqualTypeOf<JsonValue>();
  expectTypeOf<RequestInput['program']['files']>().toEqualTypeOf<Record<string, string>>();
});
