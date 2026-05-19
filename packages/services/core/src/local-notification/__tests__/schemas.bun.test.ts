import { describe, expect, it } from 'bun:test';
import { LocalNotificationSchemas } from '../schemas.js';

describe('LocalNotificationSchemas', () => {
  it('accepts only internally consistent notify responses', () => {
    const responseSchema = LocalNotificationSchemas.notify.response;

    expect(responseSchema.safeParse({ success: true }).success).toBe(true);
    expect(responseSchema.safeParse({ success: false, error: 'No notification provider available' }).success).toBe(
      true,
    );
    expect(responseSchema.safeParse({ success: true, error: 'Unexpected error' }).success).toBe(false);
    expect(responseSchema.safeParse({ success: false, error: 'No provider', extra: true }).success).toBe(false);
    expect(responseSchema.safeParse({ success: false }).success).toBe(false);
  });
});
