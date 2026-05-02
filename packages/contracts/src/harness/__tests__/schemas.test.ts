import { describe, expect, it } from 'vitest';
import { HarnessSubjects } from '../namespace.js';
import { ApprovalPolicySchema, HarnessDefinitionCreateSchema, HarnessDefinitionSchema } from '../schemas.js';

describe('HarnessDefinitionSchema', () => {
  it('accepts a valid harness definition with defaults', () => {
    const result = HarnessDefinitionSchema.safeParse({
      id: 'harness-1',
      name: 'Codex Native',
      adapterName: 'codex-app-server',
      nativeTools: { enabled: ['bash'], disabled: [] },
      registryTools: { enabled: [], disabled: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalPolicy).toBe('always-ask');
      expect(result.data.isDefault).toBe(false);
      expect(result.data.enabled).toBe(true);
    }
  });

  it('validates approval policy enum values', () => {
    expect(ApprovalPolicySchema.safeParse('reject').success).toBe(true);
    expect(ApprovalPolicySchema.safeParse('always-ask').success).toBe(true);
    expect(ApprovalPolicySchema.safeParse('full-access').success).toBe(true);
    expect(ApprovalPolicySchema.safeParse('invalid').success).toBe(false);
  });
});

describe('HarnessDefinitionCreateSchema', () => {
  it('accepts valid create input without id/timestamps', () => {
    const result = HarnessDefinitionCreateSchema.safeParse({
      name: 'OpenAI Registry',
      adapterName: 'openai-node',
      approvalPolicy: 'always-ask',
      nativeTools: { enabled: [], disabled: [] },
      registryTools: { enabled: [], disabled: [] },
      isDefault: true,
      enabled: true,
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = HarnessDefinitionCreateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('HarnessSubjects', () => {
  it('exposes CRUD and resolver subjects', () => {
    expect(HarnessSubjects.get).toBeDefined();
    expect(HarnessSubjects.list).toBeDefined();
    expect(HarnessSubjects.set).toBeDefined();
    expect(HarnessSubjects.delete).toBeDefined();
    expect(HarnessSubjects.getDefault).toBeDefined();
    expect(HarnessSubjects.resolve).toBeDefined();
    expect(HarnessSubjects.getSchema).toBeDefined();
  });
});
