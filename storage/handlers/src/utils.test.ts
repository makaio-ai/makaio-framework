import { describe, expect, it } from 'vitest';
import { nullToUndefined, undefinedToNull } from './utils';

describe('nullToUndefined', () => {
  it('converts null values to undefined for specified keys', () => {
    const input = {
      id: 'test-1',
      name: 'Test Profile',
      description: null as string | null,
      value: 42,
    };
    const result = nullToUndefined(input, ['description']);
    expect(result.description).toBeUndefined();
    expect(result.id).toBe('test-1');
    expect(result.name).toBe('Test Profile');
    expect(result.value).toBe(42);
  });

  it('converts multiple null values to undefined', () => {
    const input = {
      id: 'test-1',
      field1: null as string | null,
      field2: null as number | null,
      field3: null as boolean | null,
      field4: 'keep',
    };
    const result = nullToUndefined(input, ['field1', 'field2', 'field3']);
    expect(result.field1).toBeUndefined();
    expect(result.field2).toBeUndefined();
    expect(result.field3).toBeUndefined();
    expect(result.field4).toBe('keep');
  });

  it('does not convert non-null values', () => {
    const input = {
      id: 'test-1',
      description: 'has value',
      value: 42,
      flag: true,
    };
    const result = nullToUndefined(input, ['description', 'value', 'flag']);
    expect(result.description).toBe('has value');
    expect(result.value).toBe(42);
    expect(result.flag).toBe(true);
  });

  it('does not modify original object (immutability)', () => {
    const input = {
      id: 'test-1',
      description: null as string | null,
      value: 42,
    };
    const originalDescription = input.description;
    nullToUndefined(input, ['description']);
    expect(input.description).toBe(originalDescription);
  });

  it('returns a new object', () => {
    const input = {
      id: 'test-1',
      description: null as string | null,
    };
    const result = nullToUndefined(input, ['description']);
    expect(result).not.toBe(input);
  });

  it('handles empty keys array', () => {
    const input = {
      id: 'test-1',
      description: null as string | null,
    };
    const result = nullToUndefined(input, []);
    expect(result.description).toBeNull();
    expect(result.id).toBe('test-1');
  });

  it('does not convert undefined for non-existent keys', () => {
    const input = {
      id: 'test-1',
      name: 'test',
    };
    // Use type assertion to allow non-existent key in keys array
    const result = nullToUndefined(input, ['nonexistent' as never]);
    // Non-existent keys are undefined (not present in result), not null
    const resultRecord = result as Record<string, unknown>;
    expect(resultRecord.nonexistent).toBeUndefined();
    expect(result.id).toBe('test-1');
    expect(result.name).toBe('test');
  });

  it('converts only specified keys, leaving others with null', () => {
    const input = {
      id: 'test-1',
      field1: null as string | null,
      field2: null as string | null,
      field3: null as string | null,
    };
    const result = nullToUndefined(input, ['field1', 'field3']);
    expect(result.field1).toBeUndefined();
    expect(result.field2).toBeNull();
    expect(result.field3).toBeUndefined();
  });

  it('preserves type safety with generic types', () => {
    type TestType = {
      id: string;
      nullable: string | null;
      nonNullable: number;
    };
    const input: TestType = {
      id: 'test-1',
      nullable: null,
      nonNullable: 42,
    };
    const result = nullToUndefined(input, ['nullable']);
    // Type assertion to verify the return type matches
    const typedResult: TestType = result;
    expect(typedResult.nullable).toBeUndefined();
    expect(typedResult.nonNullable).toBe(42);
  });
});

describe('undefinedToNull', () => {
  it('converts undefined values to null for specified keys', () => {
    const input = {
      id: 'test-1',
      name: 'Test Profile',
      description: undefined as string | undefined,
      value: 42,
    };
    const result = undefinedToNull(input, ['description']);
    expect(result.description).toBeNull();
    expect(result.id).toBe('test-1');
    expect(result.name).toBe('Test Profile');
    expect(result.value).toBe(42);
  });

  it('converts multiple undefined values to null', () => {
    const input = {
      id: 'test-1',
      field1: undefined as string | undefined,
      field2: undefined as number | undefined,
      field3: undefined as boolean | undefined,
      field4: 'keep',
    };
    const result = undefinedToNull(input, ['field1', 'field2', 'field3']);
    expect(result.field1).toBeNull();
    expect(result.field2).toBeNull();
    expect(result.field3).toBeNull();
    expect(result.field4).toBe('keep');
  });

  it('does not convert defined values', () => {
    const input = {
      id: 'test-1',
      description: 'has value',
      value: 42,
      flag: true,
    };
    const result = undefinedToNull(input, ['description', 'value', 'flag']);
    expect(result.description).toBe('has value');
    expect(result.value).toBe(42);
    expect(result.flag).toBe(true);
  });

  it('does not modify original object (immutability)', () => {
    const input = {
      id: 'test-1',
      description: undefined as string | undefined,
      value: 42,
    };
    const originalDescription = input.description;
    undefinedToNull(input, ['description']);
    expect(input.description).toBe(originalDescription);
  });

  it('returns a new object', () => {
    const input = {
      id: 'test-1',
      description: undefined as string | undefined,
    };
    const result = undefinedToNull(input, ['description']);
    expect(result).not.toBe(input);
  });

  it('handles empty keys array', () => {
    const input = {
      id: 'test-1',
      description: undefined as string | undefined,
    };
    const result = undefinedToNull(input, []);
    expect(result.description).toBeUndefined();
    expect(result.id).toBe('test-1');
  });

  it('converts undefined for non-existent keys to null', () => {
    const input = {
      id: 'test-1',
      name: 'test',
    };
    // Use type assertion to allow non-existent key in keys array
    const result = undefinedToNull(input, ['nonexistent' as never]);
    // Non-existent keys are undefined, which gets converted to null by the function
    const resultRecord = result as Record<string, unknown>;
    expect(resultRecord.nonexistent).toBeNull();
    expect(result.id).toBe('test-1');
    expect(result.name).toBe('test');
  });

  it('converts only specified keys, leaving others with undefined', () => {
    const input = {
      id: 'test-1',
      field1: undefined as string | undefined,
      field2: undefined as string | undefined,
      field3: undefined as string | undefined,
    };
    const result = undefinedToNull(input, ['field1', 'field3']);
    expect(result.field1).toBeNull();
    expect(result.field2).toBeUndefined();
    expect(result.field3).toBeNull();
  });

  it('preserves type safety with generic types', () => {
    type TestType = {
      id: string;
      optional: string | undefined;
      required: number;
    };
    const input: TestType = {
      id: 'test-1',
      optional: undefined,
      required: 42,
    };
    const result = undefinedToNull(input, ['optional']);
    // Type assertion to verify the return type matches
    const typedResult: TestType = result;
    expect(typedResult.optional).toBeNull();
    expect(typedResult.required).toBe(42);
  });

  it('does not convert null values to null (idempotent)', () => {
    const input = {
      id: 'test-1',
      field1: null as string | null,
      field2: undefined as string | undefined,
    };
    const result = undefinedToNull(input, ['field1', 'field2']);
    expect(result.field1).toBeNull();
    expect(result.field2).toBeNull();
  });
});

describe('integration: nullToUndefined and undefinedToNull', () => {
  it('round-trip conversion maintains data integrity', () => {
    const original = {
      id: 'test-1',
      description: 'test description',
      value: 42,
    };
    // Simulate API -> DB -> API flow
    const toDb = undefinedToNull(original, ['description']);
    const backToApi = nullToUndefined(toDb, ['description']);
    expect(backToApi).toEqual(original);
  });

  it('handles realistic database row scenario', () => {
    type DbRow = {
      id: string;
      name: string;
      description: string | null;
      model: string | null;
      enabled: boolean;
    };

    const dbRow: DbRow = {
      id: 'profile-1',
      name: 'flash-reader',
      description: null,
      model: null,
      enabled: true,
    };

    const apiType = nullToUndefined(dbRow, ['description', 'model']);
    expect(apiType.description).toBeUndefined();
    expect(apiType.model).toBeUndefined();
    expect(apiType.enabled).toBe(true);
  });

  it('handles realistic API input scenario', () => {
    type ApiInput = {
      id: string;
      name: string;
      description?: string;
      model?: string;
      enabled: boolean;
    };

    const apiInput: ApiInput = {
      id: 'profile-1',
      name: 'flash-reader',
      description: undefined,
      model: undefined,
      enabled: true,
    };

    const dbValues = undefinedToNull(apiInput, ['description', 'model']);
    expect(dbValues.description).toBeNull();
    expect(dbValues.model).toBeNull();
    expect(dbValues.enabled).toBe(true);
  });
});
