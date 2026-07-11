import { describe, expect, it } from 'bun:test';
import { checkShardCoverage, extractShardsFromWorkflowYaml } from './ci-shard-coverage.js';

describe('checkShardCoverage', () => {
  describe('unclaimed projects', () => {
    it('returns no issues when all projects are claimed', () => {
      const issues = checkShardCoverage({
        projectNames: ['Core', 'Packages', 'forks-required'],
        claimedShards: ['Core', 'Packages', 'forks-required'],
      });
      expect(issues).toEqual([]);
    });

    it('reports unclaimed projects', () => {
      const issues = checkShardCoverage({
        projectNames: ['Core', 'Packages', 'product-core'],
        claimedShards: ['Core', 'Packages'],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/product-core/);
      expect(issues[0]).toMatch(/no CI shard claims/i);
    });

    it('does not report intentionally-unclaimed projects', () => {
      const issues = checkShardCoverage({
        projectNames: ['Core', 'Packages', 'watchman'],
        claimedShards: ['Core', 'Packages'],
        intentionallyUnclaimed: ['watchman'],
      });
      expect(issues).toEqual([]);
    });
  });

  describe('stale claims', () => {
    it('reports a claimed shard that matches no project', () => {
      const issues = checkShardCoverage({
        projectNames: ['Core', 'Packages'],
        claimedShards: ['Core', 'Packages', 'ghost-shard'],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/ghost-shard/);
      expect(issues[0]).toMatch(/no matching Vitest project/i);
    });

    it('reports stale claims even with an empty project list', () => {
      const issues = checkShardCoverage({ projectNames: [], claimedShards: ['Core'] });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/Core/);
    });
  });

  describe('combined scenarios', () => {
    it('reports both unclaimed projects and stale claims simultaneously', () => {
      const issues = checkShardCoverage({
        projectNames: ['Core', 'new-project'],
        claimedShards: ['Core', 'old-shard'],
      });
      const combined = issues.join('\n');
      expect(combined).toMatch(/new-project/);
      expect(combined).toMatch(/old-shard/);
    });

    it('returns no issues for a fully matched realistic framework config', () => {
      const issues = checkShardCoverage({
        projectNames: [
          'Core',
          'Packages',
          'Platform',
          'Adapters',
          'Extensions',
          'Apps',
          'forks-required',
          'git-serial',
        ],
        claimedShards: ['Core', 'Packages', 'Platform', 'Adapters', 'Extensions', 'Apps', 'forks-required'],
        intentionallyUnclaimed: ['git-serial'],
      });
      expect(issues).toEqual([]);
    });
  });
});

describe('extractShardsFromWorkflowYaml', () => {
  it('extracts shard list from a well-formed test_shards YAML line', () => {
    const yaml = `
jobs:
  ci:
    uses: ./.github/workflows/ci-reusable.yml
    with:
      test_shards: '["Core", "Packages", "Platform"]'
`;
    expect(extractShardsFromWorkflowYaml(yaml)).toEqual(['Core', 'Packages', 'Platform']);
  });

  it('extracts shard list from a double-quoted test_shards YAML line', () => {
    const yaml = `      test_shards: "[\\"Core\\", \\"Packages\\"]"`;
    expect(extractShardsFromWorkflowYaml(yaml)).toEqual(['Core', 'Packages']);
  });

  it('throws when the test_shards key is not found', () => {
    expect(() => extractShardsFromWorkflowYaml('name: CI\njobs:\n  ci:\n    uses: test\n')).toThrow(/test_shards/);
  });

  it('throws when the JSON array is malformed', () => {
    expect(() => extractShardsFromWorkflowYaml(`      test_shards: '["Core", broken'`)).toThrow();
  });

  it('throws when the extracted value is not a string array', () => {
    expect(() => extractShardsFromWorkflowYaml(`      test_shards: '[42, true]'`)).toThrow(/string array/i);
  });
});
