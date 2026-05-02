import { describe, expect, it } from 'vitest';
import { ToastPayloadSchema } from '@makaio/contracts/toast';

describe('ToastSchemas', () => {
  it('accepts a valid toast.show payload with actions', () => {
    const result = ToastPayloadSchema.safeParse({
      level: 'warning',
      message: 'Usage stream not configured',
      title: 'Account Manager',
      toastId: 'am-usage-warning',
      actions: [{ id: 'configure', label: 'Configure' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects actions without toastId', () => {
    const result = ToastPayloadSchema.safeParse({
      level: 'info',
      message: 'test',
      actions: [{ id: 'a', label: 'A' }],
    });
    expect(result.success).toBe(false);
  });
});
