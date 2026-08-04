import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('standalone framework workspace', () => {
  it('recognizes the scripts package as a standalone workspace', () => {
    const frameworkRoot = new URL('../..', import.meta.url);
    const fixture = mkdtempSync(join(tmpdir(), 'framework-workspace-'));
    tempDirs.push(fixture);
    cpSync(new URL('package.json', frameworkRoot), join(fixture, 'package.json'));
    mkdirSync(join(fixture, 'scripts'));
    cpSync(new URL('scripts/package.json', frameworkRoot), join(fixture, 'scripts/package.json'));
    writeFileSync(join(fixture, 'yarn.lock'), '');

    const output = execFileSync('yarn', ['workspaces', 'list', '--json'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    const workspaces = output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { location: string });

    expect(workspaces.some((workspace) => workspace.location === 'scripts')).toBe(true);
  });
});
