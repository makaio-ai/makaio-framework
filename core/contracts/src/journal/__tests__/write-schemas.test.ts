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

  it('accepts a valid three-level chain and the result equals the input structurally', () => {
    const chain = buildParentChain(3);

    const result = ExternalObjectRefSchema.safeParse(chain);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(chain);
    }
  });

  it('rejects a stateful parent getter (first read undefined, later reads a fresh object carrying the same getter) without a RangeError', () => {
    let reads = 0;
    const buildStatefulNode = (): Record<string, unknown> => {
      const node: Record<string, unknown> = { ...validRef };
      Object.defineProperty(node, 'parent', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return reads === 1 ? undefined : buildStatefulNode();
        },
      });
      return node;
    };

    const result = () => ExternalObjectRefSchema.safeParse(buildStatefulNode());

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
    expect(reads).toBe(0);
  });

  it('rejects an accessor parent even when it would return a valid reference', () => {
    let reads = 0;
    const node: Record<string, unknown> = { ...validRef };
    Object.defineProperty(node, 'parent', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return { ...validRef, externalId: 'parent-1' };
      },
    });

    expect(ExternalObjectRefSchema.safeParse(node).success).toBe(false);
    expect(reads).toBe(0);
  });

  it.each([
    { label: 'site', field: 'site' },
    { label: 'url', field: 'url' },
  ])('rejects a $label whose value is a caller-owned object with a throwing getter, without reading it', ({
    field,
  }) => {
    let reads = 0;
    const throwingLeaf: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(throwingLeaf, 'constructor', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error('caller getter');
      },
    });
    const withThrowingLeaf = { ...validRef, [field]: throwingLeaf };

    const result = () => ExternalObjectRefSchema.safeParse(withThrowingLeaf);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
    expect(reads).toBe(0);
  });

  it('rejects a revoked Proxy used as the reference, without throwing', () => {
    const { proxy, revoke } = Proxy.revocable({ ...validRef }, {});
    revoke();

    const result = () => ExternalObjectRefSchema.safeParse(proxy);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
  });

  it('rejects a Proxy parent whose ownKeys trap throws, without throwing', () => {
    const node: Record<string, unknown> = { ...validRef };
    node.parent = new Proxy(
      { ...validRef, externalId: 'parent-1' },
      {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      },
    );

    const result = () => ExternalObjectRefSchema.safeParse(node);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
  });

  /**
   * Builds a callable Proxy whose `getPrototypeOf` trap counts its calls and throws.
   * @returns The proxy and a reader for the number of trap calls.
   */
  function countingCallableProxy(): { proxy: () => void; trapCalls: () => number } {
    let calls = 0;
    const proxy = new Proxy(() => {}, {
      getPrototypeOf() {
        calls += 1;
        throw new Error('caller trap');
      },
    });
    return { proxy, trapCalls: () => calls };
  }

  it('rejects a callable Proxy used as the reference without running its traps', () => {
    const { proxy, trapCalls } = countingCallableProxy();

    const result = () => ExternalObjectRefSchema.safeParse(proxy);

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
    expect(trapCalls()).toBe(0);
  });

  it('rejects a callable Proxy used as parent without running its traps', () => {
    const { proxy, trapCalls } = countingCallableProxy();

    const result = () => ExternalObjectRefSchema.safeParse({ ...validRef, parent: proxy });

    expect(result).not.toThrow();
    expect(result().success).toBe(false);
    expect(trapCalls()).toBe(0);
  });

  it('rejects a revoked callable Proxy as the reference and as parent, without throwing', () => {
    const { proxy, revoke } = Proxy.revocable(() => {}, {});
    revoke();

    const asReference = () => ExternalObjectRefSchema.safeParse(proxy);
    const asParent = () => ExternalObjectRefSchema.safeParse({ ...validRef, parent: proxy });

    expect(asReference).not.toThrow();
    expect(asReference().success).toBe(false);
    expect(asParent).not.toThrow();
    expect(asParent().success).toBe(false);
  });

  it("parses a valid reference without url while a polluted Object.prototype setter and getter for extension never run against this guard's own copies", () => {
    let extensionGetterCalls = 0;
    const extensionDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'extension');

    try {
      Object.defineProperty(Object.prototype, 'extension', {
        configurable: true,
        get() {
          extensionGetterCalls += 1;
          return 'from-prototype';
        },
        // No setter captured here: `extension` is required and present on every
        // valid reference, so zod's own successful-parse result (an ordinary
        // object it allocates itself, see `copyLevel`'s TSDoc) assigns it
        // unconditionally; that one allocation and assignment is zod's, not one
        // of this guard's null-prototype copies, and is pre-existing, independent
        // of `copyLevel`/`readParentChain` (reproducible with a bare `z.object()`
        // schema). This guard's own contract, asserted below, is that reading
        // `extension` off its own copy — while `copyLevel` builds it and while
        // the schema validates it — never reaches a polluted `Object.prototype`.
        set() {
          /* intentionally empty: see the comment on `get` above */
        },
      });

      const result = ExternalObjectRefSchema.safeParse(validRef);

      expect(result.success).toBe(true);
      expect(extensionGetterCalls).toBe(0);
    } finally {
      if (extensionDescriptor) {
        Object.defineProperty(Object.prototype, 'extension', extensionDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, 'extension');
      }
    }
  });

  it('parses a valid reference without url while a polluted Object.prototype setter and getter for the absent url never run', () => {
    let setterCalls = 0;
    let getterCalls = 0;
    const urlDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'url');

    try {
      Object.defineProperty(Object.prototype, 'url', {
        configurable: true,
        get() {
          getterCalls += 1;
          return 'from-prototype';
        },
        set() {
          setterCalls += 1;
        },
      });

      const result = ExternalObjectRefSchema.safeParse(validRef);

      expect(result.success).toBe(true);
      expect(setterCalls).toBe(0);
      expect(getterCalls).toBe(0);
    } finally {
      if (urlDescriptor) {
        Object.defineProperty(Object.prototype, 'url', urlDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, 'url');
      }
    }
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
