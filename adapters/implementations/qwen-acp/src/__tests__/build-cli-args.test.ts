/**
 * Tests for buildCliArgs utility
 *
 * Verifies that CLI arguments are assembled correctly from connector config.
 */

import { describe, it, expect } from 'vitest';
import { buildCliArgs } from '../utils/build-cli-args.js';

describe('buildCliArgs', () => {
  it('always includes --acp as the first argument', () => {
    const result = buildCliArgs({});
    expect(result[0]).toBe('--acp');
  });

  it('always includes --include-partial-messages and --output-format stream-json', () => {
    const result = buildCliArgs({});
    expect(result).toContain('--include-partial-messages');
    const outputFormatIdx = result.indexOf('--output-format');
    expect(outputFormatIdx).toBeGreaterThan(-1);
    expect(result[outputFormatIdx + 1]).toBe('stream-json');
  });

  it('returns fixed protocol flags when no optional flags are present', () => {
    const expected = ['--acp', '--include-partial-messages', '--output-format', 'stream-json'];
    expect(buildCliArgs({})).toEqual(expected);
    expect(buildCliArgs({ model: undefined, providerConfig: {} })).toEqual(expected);
  });

  it('includes --model when model is provided', () => {
    const result = buildCliArgs({ model: 'qwen3-coder' });
    expect(result).toEqual([
      '--acp',
      '--model',
      'qwen3-coder',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
    ]);
  });

  it('includes --approval-mode when approvalMode is provided', () => {
    const result = buildCliArgs({ providerConfig: { approvalMode: 'yolo' } });
    expect(result).toEqual([
      '--acp',
      '--approval-mode',
      'yolo',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
    ]);
  });

  it('includes --auth-type when authType is provided', () => {
    const result = buildCliArgs({ providerConfig: { authType: 'openai' } });
    expect(result).toEqual([
      '--acp',
      '--auth-type',
      'openai',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
    ]);
  });

  it('includes all flags when all options are present', () => {
    const result = buildCliArgs({
      model: 'qwen3-coder',
      providerConfig: { approvalMode: 'auto-edit', authType: 'anthropic' },
    });
    expect(result).toEqual([
      '--acp',
      '--model',
      'qwen3-coder',
      '--approval-mode',
      'auto-edit',
      '--auth-type',
      'anthropic',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
    ]);
  });

  it('preserves flag order: model before approvalMode before authType before protocol flags', () => {
    const result = buildCliArgs({
      model: 'qwen3-coder',
      providerConfig: { approvalMode: 'default', authType: 'gemini' },
    });
    const modelIdx = result.indexOf('--model');
    const approvalIdx = result.indexOf('--approval-mode');
    const authIdx = result.indexOf('--auth-type');
    const partialIdx = result.indexOf('--include-partial-messages');
    const outputIdx = result.indexOf('--output-format');
    expect(modelIdx).toBeLessThan(approvalIdx);
    expect(approvalIdx).toBeLessThan(authIdx);
    expect(authIdx).toBeLessThan(partialIdx);
    expect(partialIdx).toBeLessThan(outputIdx);
  });
});
