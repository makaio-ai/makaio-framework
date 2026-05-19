import { describe, expect, it } from 'bun:test';
import {
  ExtensionWarningActionSchema,
  ExtensionWarningSchema,
  ExtensionWarningSeveritySchema,
  getExtensionWarningActionLabel,
} from '@makaio/contracts/extension';

describe('ExtensionWarningSchema', () => {
  it('accepts a degraded warning with configure-integration action', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'degraded',
      title: 'Usage stream not configured',
      message: 'API polling every 2 minutes',
      action: { kind: 'configure-integration', clientId: 'claude-code', bundle: 'usage-stream' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a warning without action', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'info',
      title: 'Note',
      message: 'Something informational',
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown action kind', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'degraded',
      title: 'Test',
      message: 'Test',
      action: { kind: 'unknown-action' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown severity', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'critical',
      title: 'Test',
      message: 'Test',
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'info',
      title: 'No message',
    });

    expect(result.success).toBe(false);
  });
});

describe('ExtensionWarningActionSchema', () => {
  it('accepts install-extension action', () => {
    const result = ExtensionWarningActionSchema.safeParse({
      kind: 'install-extension',
      extensionName: 'makaio-git',
    });

    expect(result.success).toBe(true);
  });

  it('accepts open-url action', () => {
    const result = ExtensionWarningActionSchema.safeParse({
      kind: 'open-url',
      url: 'https://example.com/setup',
    });

    expect(result.success).toBe(true);
  });

  it('accepts run-command action', () => {
    const result = ExtensionWarningActionSchema.safeParse({
      kind: 'run-command',
      command: 'extension.runSetup',
    });

    expect(result.success).toBe(true);
  });
});

describe('getExtensionWarningActionLabel', () => {
  it('returns the canonical label for each action kind', () => {
    expect(
      getExtensionWarningActionLabel({
        kind: 'configure-integration',
        clientId: 'claude-code',
        bundle: 'usage-stream',
      }),
    ).toBe('Configure');
    expect(getExtensionWarningActionLabel({ kind: 'install-extension', extensionName: 'helper' })).toBe('Install');
    expect(getExtensionWarningActionLabel({ kind: 'open-url', url: 'https://example.com' })).toBe('Open');
    expect(getExtensionWarningActionLabel({ kind: 'run-command', command: 'extension.setup' })).toBe('Run');
  });
});

describe('ExtensionWarningSeveritySchema', () => {
  it('accepts all valid severity values', () => {
    expect(ExtensionWarningSeveritySchema.safeParse('info').success).toBe(true);
    expect(ExtensionWarningSeveritySchema.safeParse('recommended').success).toBe(true);
    expect(ExtensionWarningSeveritySchema.safeParse('degraded').success).toBe(true);
  });

  it('rejects unknown severity values', () => {
    expect(ExtensionWarningSeveritySchema.safeParse('critical').success).toBe(false);
    expect(ExtensionWarningSeveritySchema.safeParse('warning').success).toBe(false);
    expect(ExtensionWarningSeveritySchema.safeParse('').success).toBe(false);
  });
});

describe('ExtensionWarningSchema string validation edge cases', () => {
  it('rejects an empty title', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'info',
      title: '',
      message: 'Some message',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'info',
      title: 'Some title',
      message: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed URL in open-url action', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'info',
      title: 'Some title',
      message: 'Some message',
      action: { kind: 'open-url', url: 'not-a-url' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts a valid absolute URL in open-url action', () => {
    const result = ExtensionWarningSchema.safeParse({
      severity: 'info',
      title: 'Some title',
      message: 'Some message',
      action: { kind: 'open-url', url: 'https://example.com/docs/setup' },
    });

    expect(result.success).toBe(true);
  });
});
