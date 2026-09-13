import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceValidator } from './lib/validate/index.js';
import type { ValidationResult, ValidationSummary } from './lib/validate/index.js';
import { parseCliArgs, runValidateCli } from './validate.js';

describe('parseCliArgs', () => {
  it('defaults to fix mode', () => {
    expect(parseCliArgs([]).flags.fix).toBe(true);
  });

  it('supports opting out of fixes explicitly', () => {
    expect(parseCliArgs(['--no-fix']).flags.fix).toBe(false);
  });

  it('enables validator caches by default', () => {
    expect(parseCliArgs([]).flags.cache).toBe(true);
  });

  it('supports opting out of validator caches explicitly', () => {
    expect(parseCliArgs(['--no-cache']).flags.cache).toBe(false);
  });

  it('lets the last cache flag win', () => {
    expect(parseCliArgs(['--no-cache', '--cache']).flags.cache).toBe(true);
    expect(parseCliArgs(['--cache', '--no-cache']).flags.cache).toBe(false);
  });

  it('accepts both profile syntaxes for valid values', () => {
    expect(parseCliArgs(['--profile', 'full-workspace']).profile).toBe('full-workspace');
    expect(parseCliArgs(['--profile=standalone']).profile).toBe('standalone');
  });

  it('accepts a single validation tool', () => {
    expect(parseCliArgs(['--tool', 'biome']).tools).toEqual(['biome']);
    expect(parseCliArgs(['--tool', 'typescript']).tools).toEqual(['typescript']);
    expect(parseCliArgs(['--tool=eslint']).tools).toEqual(['eslint']);
  });

  it('accepts comma-separated validation tools', () => {
    expect(parseCliArgs(['--tools', 'biome,stylelint']).tools).toEqual(['biome', 'stylelint']);
    expect(parseCliArgs(['--tools=eslint,typescript']).tools).toEqual(['eslint', 'typescript']);
  });

  it('accepts multiple literal files or one glob pattern', () => {
    expect(parseCliArgs(['file1.ts', 'file2.ts']).files).toEqual(['file1.ts', 'file2.ts']);
    expect(parseCliArgs(['src/**/*.ts']).globPattern).toBe('src/**/*.ts');
  });

  it('fails fast for invalid profile values', () => {
    expect(() => parseCliArgs(['--profile', 'invalid'])).toThrow(
      'Invalid value for --profile. Use "standalone" or "full-workspace".',
    );
    expect(() => parseCliArgs(['--profile=invalid'])).toThrow(
      'Invalid value for --profile. Use "standalone" or "full-workspace".',
    );
  });

  it('fails fast for invalid tool values', () => {
    expect(() => parseCliArgs(['--tool', 'unknown'])).toThrow(
      'Invalid value for --tool. Use one of: biome, prettier, eslint, stylelint, typescript.',
    );
    expect(() => parseCliArgs(['--tools=eslint,unknown'])).toThrow(
      'Invalid value for --tool. Use one of: biome, prettier, eslint, stylelint, typescript.',
    );
  });

  it('fails fast when literal files and glob patterns are mixed', () => {
    expect(() => parseCliArgs(['file1.ts', 'src/**/*.ts'])).toThrow(
      'Cannot mix literal file paths with glob patterns. Use either multiple files or a single glob.',
    );
    expect(() => parseCliArgs(['src/**/*.ts', 'framework/**/*.ts'])).toThrow(
      'Cannot pass multiple glob patterns. Use a single glob pattern or multiple literal files.',
    );
  });
});

const FILE = '/workspace/example.ts';

function summary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    fileResults: {},
    totalFiles: 1,
    filesWithErrors: 0,
    fixableFiles: [],
    unfixableFiles: [],
    suggestedActions: [],
    toolStatuses: [{ tool: 'eslint', status: 'ok' }],
    ...overrides,
  };
}

function sourceError(): ValidationResult {
  return {
    tool: 'eslint',
    message: 'source error',
    severity: 'error',
  };
}

describe('runValidateCli', () => {
  const validate = vi.spyOn(WorkspaceValidator.prototype, 'validate');
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

  beforeEach(() => {
    validate.mockReset();
    info.mockClear();
  });

  afterEach(() => {
    validate.mockReset();
    info.mockClear();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns source-error status for JSON output', async () => {
    validate.mockResolvedValue(summary({ fileResults: { [FILE]: [sourceError()] }, filesWithErrors: 1 }));

    await expect(runValidateCli(['--json', '--tools', 'eslint', 'example.ts'])).resolves.toBe(1);
  });

  it('returns worker-failure status for JSON output while preserving the payload', async () => {
    const expected = summary({ toolStatuses: [{ tool: 'eslint', status: 'failed', error: 'worker unavailable' }] });
    validate.mockResolvedValue(expected);

    await expect(runValidateCli(['--json', '--tools', 'eslint', 'example.ts'])).resolves.toBe(2);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual(expected);
  });

  it('gives a source error precedence over a worker failure', async () => {
    validate.mockResolvedValue(
      summary({
        fileResults: { [FILE]: [sourceError()] },
        filesWithErrors: 1,
        toolStatuses: [{ tool: 'eslint', status: 'failed', error: 'worker unavailable' }],
      }),
    );

    await expect(runValidateCli(['--json', '--tools', 'eslint', 'example.ts'])).resolves.toBe(1);
  });

  it('returns success for a clean summary', async () => {
    validate.mockResolvedValue(summary());

    await expect(runValidateCli(['--json', '--tools', 'eslint', 'example.ts'])).resolves.toBe(0);
  });

  it('keeps automatically fixed errors successful', async () => {
    validate.mockResolvedValue(
      summary({
        fileResults: { [FILE]: [{ ...sourceError(), fixedAutomatically: true }] },
        fixableFiles: [],
      }),
    );

    await expect(runValidateCli(['--json', '--tools', 'eslint', 'example.ts'])).resolves.toBe(0);
  });

  it('does not report a failed worker as clean in human output', async () => {
    validate.mockResolvedValue(
      summary({ toolStatuses: [{ tool: 'eslint', status: 'failed', error: 'worker unavailable' }] }),
    );

    await expect(runValidateCli(['--tools', 'eslint', 'example.ts'])).resolves.toBe(2);

    const output = info.mock.calls.flat().join('\n');
    expect(output).toContain('1 failed tool');
    expect(output).not.toMatch(/clean|all files passed|no issues found/i);
  });
});

describe('runValidateCli worker-spawn integration', () => {
  it('returns worker-failure status from a real failed TypeScript worker spawn', async () => {
    const previousPath = process.env.PATH;
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      process.env.PATH = '/definitely-missing-makaio-validate-worker';

      await expect(
        runValidateCli(['--json', '--no-fix', '--tools', 'typescript', fileURLToPath(import.meta.url)]),
      ).resolves.toBe(2);

      const output = JSON.parse(String(info.mock.calls.at(-1)?.[0])) as ValidationSummary;
      expect(output.toolStatuses).toEqual([
        expect.objectContaining({ tool: 'typescript', status: 'failed', error: expect.stringContaining('ENOENT') }),
      ]);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      info.mockRestore();
    }
  });
});
