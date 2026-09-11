import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_COLLECTION_ELEMENT_SEGMENT as ELEMENT,
  inspectArtifactDataLocation,
  isArtifactDataPathDeclared,
} from '../../index.js';

/**
 * Ask whether a location is declared, the way a patch engine does.
 * @param dataSchema - Serialized artifact data schema.
 * @param segments - Data-relative location segments.
 * @returns Whether the location is declared in every schema variant.
 */
function declares(dataSchema: Record<string, unknown>, segments: readonly string[]): boolean {
  return inspectArtifactDataLocation(dataSchema, segments) !== undefined;
}

const dataSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          owner: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

describe('locating a declared collection entry', () => {
  it('declares a named property', () => {
    expect(declares(dataSchema, ['title'])).toBe(true);
  });

  it('declares a collection itself', () => {
    expect(declares(dataSchema, ['tasks'])).toBe(true);
  });

  it('declares a property of one collection entry', () => {
    expect(declares(dataSchema, ['tasks', ELEMENT, 'title'])).toBe(true);
  });

  it('declares a nested property below one collection entry', () => {
    expect(declares(dataSchema, ['tasks', ELEMENT, 'owner', 'name'])).toBe(true);
  });

  it('declares a scalar collection entry', () => {
    expect(declares(dataSchema, ['blockers', ELEMENT])).toBe(true);
  });

  it('rejects a misspelled property below one collection entry', () => {
    expect(declares(dataSchema, ['tasks', ELEMENT, 'titel'])).toBe(false);
  });

  it('rejects an entry selector on something that is not a collection', () => {
    expect(declares(dataSchema, ['title', ELEMENT])).toBe(false);
  });

  it('rejects a property below a scalar collection entry', () => {
    expect(declares(dataSchema, ['blockers', ELEMENT, 'title'])).toBe(false);
  });
});

describe('inspectArtifactDataLocation', () => {
  it('reports the declared item schema of a collection entry', () => {
    expect(inspectArtifactDataLocation(dataSchema, ['blockers', ELEMENT])).toStrictEqual([{ type: 'string' }]);
  });

  it('reports the collection schema itself, so a caller can tell it from an entry', () => {
    expect(inspectArtifactDataLocation(dataSchema, ['blockers'])).toStrictEqual([
      { type: 'array', items: { type: 'string' } },
    ]);
  });

  it('reports nothing for an undeclared location', () => {
    expect(inspectArtifactDataLocation(dataSchema, ['taks'])).toBeUndefined();
  });
});

describe('isArtifactDataPathDeclared', () => {
  it('keeps traversing named properties only', () => {
    expect(isArtifactDataPathDeclared(dataSchema, 'tasks')).toBe(true);
    expect(isArtifactDataPathDeclared(dataSchema, 'tasks.title')).toBe(false);
  });
});

describe('locations below an intersected declaration', () => {
  const intersected = {
    type: 'object',
    properties: {
      tasks: {
        allOf: [{ type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } }],
      },
    },
  } as const satisfies Record<string, unknown>;

  it('keeps the item declaration of an array reached through allOf', () => {
    expect(declares(intersected, ['tasks', ELEMENT, 'title'])).toBe(true);
  });

  it('still rejects a misspelled property below that entry', () => {
    expect(declares(intersected, ['tasks', ELEMENT, 'titel'])).toBe(false);
  });
});
