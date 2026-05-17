import { describe, expect, it } from 'vitest';
import {
  buildAnnotatedTag,
  buildDevVersion,
  buildPublishArgs,
  parsePackageNames,
  renderSummary,
  resolveDevPublishPlan,
  stripPrerelease,
} from './dev-publish.js';

describe('parsePackageNames', () => {
  it('accepts explicit Makaio package names and removes duplicates', () => {
    expect(parsePackageNames('@makaio/framework @makaio/contracts\n@makaio/framework')).toEqual([
      '@makaio/framework',
      '@makaio/contracts',
    ]);
  });

  it('rejects selector aliases for dev publishes', () => {
    expect(() => parsePackageNames('changed')).toThrow(/explicit package names/u);
  });
});

describe('dev snapshot versions', () => {
  it('builds a timestamped dev version from a stable source version', () => {
    expect(buildDevVersion('1.0.0', '1780000000000')).toBe('1.0.0-dev-1780000000000');
  });

  it('replaces an existing prerelease suffix before applying the dev timestamp', () => {
    expect(stripPrerelease('1.0.0-dev-1779051654000')).toBe('1.0.0');
  });
});

describe('resolveDevPublishPlan', () => {
  it('selects only requested packages and applies one shared timestamp', () => {
    const plan = resolveDevPublishPlan(
      [
        {
          name: '@makaio/contracts',
          location: 'packages/contracts',
          version: '1.0.0',
          dependencies: {},
        },
        {
          name: '@makaio/framework',
          location: 'packages/framework',
          version: '1.0.0',
          dependencies: {
            '@makaio/contracts': 'workspace:*',
          },
        },
      ],
      ['@makaio/framework', '@makaio/contracts'],
      '1780000000000',
    );

    expect(plan.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      '@makaio/contracts@1.0.0-dev-1780000000000',
      '@makaio/framework@1.0.0-dev-1780000000000',
    ]);
  });
});

describe('buildAnnotatedTag', () => {
  it('builds package-scoped dev tags with audit metadata', () => {
    expect(
      buildAnnotatedTag({
        packageName: '@makaio/framework',
        version: '1.0.0-dev-1780000000000',
        sourceSha: 'abc123',
        workflowUrl: 'https://github.com/makaio-ai/makaio-framework/actions/runs/1',
      }),
    ).toEqual({
      name: 'dev/@makaio/framework/v1.0.0-dev-1780000000000',
      message: [
        '@makaio/framework@1.0.0-dev-1780000000000',
        '',
        'npm dist-tag: dev',
        'source: abc123',
        'workflow: https://github.com/makaio-ai/makaio-framework/actions/runs/1',
      ].join('\n'),
    });
  });
});

describe('buildPublishArgs', () => {
  it('publishes dev packages without provenance for deployment-triggered releases', () => {
    expect(buildPublishArgs('@makaio/contracts')).toEqual([
      'workspace',
      '@makaio/contracts',
      'npm',
      'publish',
      '--tag',
      'dev',
      '--access',
      'public',
    ]);
  });
});

describe('renderSummary', () => {
  it('labels dry runs without claiming packages were published', () => {
    expect(
      renderSummary(
        [
          {
            name: '@makaio/framework',
            location: 'packages/framework',
            version: '1.0.0-dev-1780000000000',
            baseVersion: '1.0.0',
            tagName: 'dev/@makaio/framework/v1.0.0-dev-1780000000000',
            dependencies: {},
          },
        ],
        'abc123',
        'https://github.com/makaio-ai/makaio-framework/actions/runs/1',
        true,
      ),
    ).toContain('### Dev package dry run');
  });
});
