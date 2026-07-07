import { describe, expect, it } from 'vitest';
import {
  FRAMEWORK_BUILD_PACKAGE_NAMES,
  FRAMEWORK_DIST_SUBPATHS,
  FRAMEWORK_NON_WORKSPACE_BUILD_INPUT_PATHS,
  FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS,
  FRAMEWORK_RUNTIME_MIGRATION_CHAIN_ROOT,
  getFrameworkDistSubpathMap,
  getFrameworkPublicPackageByName,
} from '../framework-public-surface.js';

describe('FRAMEWORK_DIST_SUBPATHS', () => {
  it('contains no duplicate subpaths', () => {
    const subpaths = FRAMEWORK_DIST_SUBPATHS.map((e) => e.subpath);
    const unique = new Set(subpaths);
    expect(unique.size).toBe(subpaths.length);
  });

  it('every entry has a non-empty subpath, sourceDist, and packageName', () => {
    for (const entry of FRAMEWORK_DIST_SUBPATHS) {
      expect(entry.subpath.length).toBeGreaterThan(0);
      expect(entry.sourceDist.length).toBeGreaterThan(0);
      expect(entry.packageName.startsWith('@makaio/')).toBe(true);
    }
  });

  it('every packageName in FRAMEWORK_DIST_SUBPATHS is present in FRAMEWORK_BUILD_PACKAGE_NAMES', () => {
    const buildSet = new Set<string>(FRAMEWORK_BUILD_PACKAGE_NAMES);
    for (const entry of FRAMEWORK_DIST_SUBPATHS) {
      expect(buildSet.has(entry.packageName), `${entry.packageName} missing from FRAMEWORK_BUILD_PACKAGE_NAMES`).toBe(
        true,
      );
    }
  });

  it('includes the clients subpath that maps to subsystem-client', () => {
    const entry = FRAMEWORK_DIST_SUBPATHS.find((e) => e.subpath === 'clients');
    expect(entry).toBeDefined();
    expect(entry?.packageName).toBe('@makaio/subsystem-client');
    expect(entry?.sourceDist).toBe('subsystems/client/dist');
  });

  it('includes the git subpath that maps to subsystem-git', () => {
    const entry = FRAMEWORK_DIST_SUBPATHS.find((e) => e.subpath === 'git');
    expect(entry).toBeDefined();
    expect(entry?.packageName).toBe('@makaio/subsystem-git');
    expect(entry?.sourceDist).toBe('subsystems/git/dist');
  });

  it('includes the node machine-identity subpath for downstream hooks', () => {
    const entry = FRAMEWORK_DIST_SUBPATHS.find((e) => e.subpath === 'node/machine-identity');
    expect(entry).toBeDefined();
    expect(entry?.packageName).toBe('@makaio/machine-identity');
    expect(entry?.sourceDist).toBe('packages/machine-identity/dist');
  });
});

describe('FRAMEWORK_BUILD_PACKAGE_NAMES', () => {
  it('contains only @makaio/* scoped packages', () => {
    for (const name of FRAMEWORK_BUILD_PACKAGE_NAMES) {
      expect(name.startsWith('@makaio/')).toBe(true);
    }
  });

  it('contains no duplicates', () => {
    const unique = new Set<string>(FRAMEWORK_BUILD_PACKAGE_NAMES);
    expect(unique.size).toBe(FRAMEWORK_BUILD_PACKAGE_NAMES.length);
  });

  it('includes build-tooling even though it is not in FRAMEWORK_DIST_SUBPATHS', () => {
    expect(FRAMEWORK_BUILD_PACKAGE_NAMES).toContain('@makaio/build-tooling');
    expect(FRAMEWORK_BUILD_PACKAGE_NAMES).toContain('@makaio/ui-theme');
    const distPackageNames: readonly string[] = FRAMEWORK_DIST_SUBPATHS.map((e) => e.packageName);
    expect(distPackageNames).not.toContain('@makaio/build-tooling');
    expect(distPackageNames).not.toContain('@makaio/ui-theme');
  });
});

describe('framework non-workspace build inputs', () => {
  it('declares copied and helper inputs outside workspace package roots', () => {
    expect(FRAMEWORK_NON_WORKSPACE_BUILD_INPUT_PATHS).toContain('scripts/lib/runtime-migration-assets.ts');
    expect(FRAMEWORK_RUNTIME_MIGRATION_CHAIN_ROOT).toBe('storage/migrations/drizzle');
  });
});

describe('FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS', () => {
  it('has exactly one entry per unique packageName from FRAMEWORK_DIST_SUBPATHS', () => {
    const distPackageNames = new Set(FRAMEWORK_DIST_SUBPATHS.map((e) => e.packageName));
    const publicPackageNames = new Set(FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.map((e) => e.packageName));
    expect(publicPackageNames).toEqual(distPackageNames);
  });

  it('contains no duplicate packageNames', () => {
    const names = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.map((e) => e.packageName);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every frameworkSubpath is a valid subpath from FRAMEWORK_DIST_SUBPATHS', () => {
    const subpathSet = new Set(FRAMEWORK_DIST_SUBPATHS.map((e) => e.subpath));
    for (const entry of FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS) {
      expect(
        subpathSet.has(entry.frameworkSubpath),
        `${entry.frameworkSubpath} not found in FRAMEWORK_DIST_SUBPATHS`,
      ).toBe(true);
    }
  });

  it('maps bus-core to the bus subpath', () => {
    const entry = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.find((e) => e.packageName === '@makaio/bus-core');
    expect(entry).toBeDefined();
    expect(entry?.frameworkSubpath).toBe('bus');
    expect(entry?.packageRoot).toBe('core/bus-core');
  });

  it('tools-core maps to the primary tools subpath, not tools/testing', () => {
    const entry = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.find((e) => e.packageName === '@makaio/tools-core');
    expect(entry?.frameworkSubpath).toBe('tools');
    expect(entry?.packageRoot).toBe('core/tools-core');
  });

  it('maps framework packages referenced by public declarations to umbrella subpaths', () => {
    expect(getFrameworkPublicPackageByName('@makaio/subsystem-adapter')?.frameworkSubpath).toBe('adapter-subsystem');
    expect(getFrameworkPublicPackageByName('@makaio/inbound-hooks')?.frameworkSubpath).toBe('inbound-hooks');
  });

  it('does not expose descriptor-owned tool extensions as tools subpaths', () => {
    const subpathSet = new Set<string>(FRAMEWORK_DIST_SUBPATHS.map((e) => e.subpath));
    expect(subpathSet.has('tools/filesystem')).toBe(false);
    expect(subpathSet.has('tools/shell')).toBe(false);
    expect(subpathSet.has('tools/subagent')).toBe(false);
  });
});

describe('getFrameworkDistSubpathMap', () => {
  it('returns a map with the same size as FRAMEWORK_DIST_SUBPATHS', () => {
    const map = getFrameworkDistSubpathMap();
    expect(map.size).toBe(FRAMEWORK_DIST_SUBPATHS.length);
  });

  it('resolves a known subpath to the correct entry', () => {
    const map = getFrameworkDistSubpathMap();
    const entry = map.get('bus');
    expect(entry?.packageName).toBe('@makaio/bus-core');
    expect(entry?.sourceDist).toBe('core/bus-core/dist');
  });

  it('returns undefined for an unknown subpath', () => {
    const map = getFrameworkDistSubpathMap();
    expect(map.get('nonexistent')).toBeUndefined();
  });
});

describe('getFrameworkPublicPackageByName', () => {
  it('resolves a known package name to its entry', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/bus-core');
    expect(entry?.frameworkSubpath).toBe('bus');
    expect(entry?.packageRoot).toBe('core/bus-core');
  });

  it('returns undefined for an unknown package name', () => {
    expect(getFrameworkPublicPackageByName('@makaio/nonexistent')).toBeUndefined();
  });

  it('resolves subsystem-client correctly', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/subsystem-client');
    expect(entry?.frameworkSubpath).toBe('clients');
    expect(entry?.packageRoot).toBe('subsystems/client');
  });

  it('resolves subsystem-git correctly', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/subsystem-git');
    expect(entry?.frameworkSubpath).toBe('git');
    expect(entry?.packageRoot).toBe('subsystems/git');
  });

  it('resolves @makaio/runtime-node to the runtime-node subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/runtime-node');
    expect(entry?.frameworkSubpath).toBe('runtime-node');
    expect(entry?.packageRoot).toBe('runtimes/node');
  });

  it('resolves @makaio/runtime-bun to the runtime-bun subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/runtime-bun');
    expect(entry?.frameworkSubpath).toBe('runtime-bun');
    expect(entry?.packageRoot).toBe('runtimes/bun');
  });

  it('resolves @makaio/rules to the rules subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/rules');
    expect(entry?.frameworkSubpath).toBe('rules');
    expect(entry?.packageRoot).toBe('packages/rules');
  });

  it('resolves @makaio/expression to the expression subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/expression');
    expect(entry?.frameworkSubpath).toBe('expression');
    expect(entry?.packageRoot).toBe('packages/expression');
  });

  it('resolves @makaio/subsystem-mcp-http-server to the mcp-http-server subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/subsystem-mcp-http-server');
    expect(entry?.frameworkSubpath).toBe('mcp-http-server');
    expect(entry?.packageRoot).toBe('subsystems/mcp-http-server');
  });

  it('resolves @makaio/subsystem-workflow-engine to the workflow-engine subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/subsystem-workflow-engine');
    expect(entry?.frameworkSubpath).toBe('workflow-engine');
    expect(entry?.packageRoot).toBe('subsystems/workflow-engine');
  });

  it('resolves @makaio/machine-identity to the node machine-identity facade subpath', () => {
    const entry = getFrameworkPublicPackageByName('@makaio/machine-identity');
    expect(entry?.frameworkSubpath).toBe('node/machine-identity');
    expect(entry?.packageRoot).toBe('packages/machine-identity');
  });
});
