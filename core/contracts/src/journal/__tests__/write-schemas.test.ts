import { describe, expect, it } from 'vitest';
import {
  CreateTargetSchema,
  EXTERNAL_OBJECT_REF_MAX_DEPTH,
  ExternalObjectRefSchema,
  IntentIdSchema,
  WriteRecordViewSchema,
  WriteRequestSchema,
} from '../index.js';

/** A minimal valid {@link ExternalObjectRef}, used as a base for variations. */
const validRef = {
  extension: 'acme',
  site: 'site-1',
  objectType: 'issue',
  externalId: 'ext-1',
};

/** A minimal valid write request, used as a base for `participant` variations. */
const validWriteRequest = {
  key: 'write-key-1',
  writer: 'acme.writer',
  target: { create: { site: 'site-1', objectType: 'issue' } },
  content: { title: 'hello' },
  credential: { purpose: 'write' },
};

describe('ExternalObjectRefSchema', () => {
  it('accepts a full valid reference without parent or url', () => {
    expect(ExternalObjectRefSchema.safeParse(validRef).success).toBe(true);
  });

  it('accepts a full valid reference with parent and url', () => {
    const withParentAndUrl = {
      ...validRef,
      parent: { ...validRef, externalId: 'parent-1' },
      url: 'https://example.invalid/ext-1',
    };

    expect(ExternalObjectRefSchema.safeParse(withParentAndUrl).success).toBe(true);
  });

  it.each([
    { label: 'site', field: 'site' },
    { label: 'objectType', field: 'objectType' },
    { label: 'externalId', field: 'externalId' },
  ])('rejects an empty $label', ({ field }) => {
    const invalid = { ...validRef, [field]: '' };

    expect(ExternalObjectRefSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a nested parent with an empty identity field', () => {
    const withInvalidParent = { ...validRef, parent: { ...validRef, site: '' } };

    expect(ExternalObjectRefSchema.safeParse(withInvalidParent).success).toBe(false);
  });
});

/**
 * Builds a `parent` chain of exactly `depth` object levels (including the
 * returned, topmost object), none of them sharing an identity.
 * @param depth - Number of levels the chain is to have.
 * @returns The topmost object of the chain.
 */
function buildParentChain(depth: number): unknown {
  let node: Record<string, unknown> = { ...validRef, externalId: 'leaf' };

  for (let level = 1; level < depth; level += 1) {
    node = { ...validRef, externalId: `level-${level}`, parent: node };
  }

  return node;
}

describe('ExternalObjectRefSchema parent chain', () => {
  it('rejects a self-cycle without throwing', () => {
    const selfCycle: Record<string, unknown> = { ...validRef };
    selfCycle.parent = selfCycle;

    const result = () => ExternalObjectRefSchema.safeParse(selfCycle);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
  });

  it('rejects a two-element cycle without throwing', () => {
    const first: Record<string, unknown> = { ...validRef, externalId: 'first' };
    const second: Record<string, unknown> = { ...validRef, externalId: 'second' };
    first.parent = second;
    second.parent = first;

    const result = () => ExternalObjectRefSchema.safeParse(first);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
  });

  it('accepts a chain of exactly the depth limit', () => {
    const chain = buildParentChain(EXTERNAL_OBJECT_REF_MAX_DEPTH);

    expect(ExternalObjectRefSchema.safeParse(chain).success).toBe(true);
  });

  it('rejects a chain one level longer than the depth limit', () => {
    const chain = buildParentChain(EXTERNAL_OBJECT_REF_MAX_DEPTH + 1);

    expect(ExternalObjectRefSchema.safeParse(chain).success).toBe(false);
  });

  it('rejects a 100 000-deep chain without throwing', () => {
    const chain = buildParentChain(100_000);

    const result = () => ExternalObjectRefSchema.safeParse(chain);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
  });
});

describe('CreateTargetSchema', () => {
  it('rejects an empty site', () => {
    expect(CreateTargetSchema.safeParse({ site: '', objectType: 'issue' }).success).toBe(false);
  });

  it('rejects an empty objectType', () => {
    expect(CreateTargetSchema.safeParse({ site: 'site-1', objectType: '' }).success).toBe(false);
  });

  it('accepts a valid target without parent', () => {
    expect(CreateTargetSchema.safeParse({ site: 'site-1', objectType: 'issue' }).success).toBe(true);
  });

  it('accepts a valid target with parent', () => {
    expect(CreateTargetSchema.safeParse({ site: 'site-1', objectType: 'issue', parent: validRef }).success).toBe(true);
  });
});

describe('WriteRequestSchema participant', () => {
  it('is optional', () => {
    expect(WriteRequestSchema.safeParse(validWriteRequest).success).toBe(true);
  });

  it('accepts a valid contribution name', () => {
    const withParticipant = { ...validWriteRequest, participant: { name: 'acme.participant', data: null } };

    expect(WriteRequestSchema.safeParse(withParticipant).success).toBe(true);
  });

  it('rejects an empty participant name', () => {
    const withEmptyName = { ...validWriteRequest, participant: { name: '', data: null } };

    expect(WriteRequestSchema.safeParse(withEmptyName).success).toBe(false);
  });

  it('rejects a name ContributionNameSchema rejects (no owner dot)', () => {
    const withInvalidName = { ...validWriteRequest, participant: { name: 'noDotHere', data: null } };

    expect(WriteRequestSchema.safeParse(withInvalidName).success).toBe(false);
  });

  it('accepts any JSON value as participant.data', () => {
    const withObjectData = {
      ...validWriteRequest,
      participant: { name: 'acme.participant', data: { nested: [1, 'two', null] } },
    };

    expect(WriteRequestSchema.safeParse(withObjectData).success).toBe(true);
  });
});

describe('IntentIdSchema', () => {
  it('accepts any string', () => {
    expect(IntentIdSchema.safeParse('').success).toBe(true);
    expect(IntentIdSchema.safeParse('intent-1').success).toBe(true);
  });

  it('rejects a non-string value', () => {
    expect(IntentIdSchema.safeParse(1).success).toBe(false);
  });

  it('is nullable where the record schema exposes it', () => {
    expect(WriteRecordViewSchema.shape.intentId.safeParse(null).success).toBe(true);
  });
});
