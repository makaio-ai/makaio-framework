import { describe, expect, it } from 'vitest';
import { getObservabilityFieldPolicy, getObservabilitySchemaPolicy } from '@makaio/core';
import { CrudSchemas } from '../schemas/crud.js';

describe('session crud observability metadata', () => {
  it('allows traceAll for session list request while hiding offset', () => {
    const schema = CrudSchemas.list.request;

    expect(getObservabilitySchemaPolicy(schema)).toEqual({ traceAll: true });
    expect(getObservabilityFieldPolicy(schema.shape.offset)).toEqual({ visibility: 'hidden' });
  });
});
