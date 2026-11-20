import { describe, expect, it } from 'vitest';
import { zodSchemaToJsonRecord } from '../../shared/zod-json-schema.js';
import { TransitionEvaluationContextSchemas } from '../transition.js';

describe('TransitionEvaluationContextSchemas', () => {
  it('does not require previous or current on artifact.status.changed, since both may be absent', () => {
    const schema = zodSchemaToJsonRecord(TransitionEvaluationContextSchemas['artifact.status.changed']);
    const required = schema['required'];

    expect(required).toEqual(expect.arrayContaining(['artifact', 'path', '_transition']));
    expect(required).not.toContain('previous');
    expect(required).not.toContain('current');
    expect(schema['properties']).toMatchObject({ previous: {}, current: {} });
  });
});
