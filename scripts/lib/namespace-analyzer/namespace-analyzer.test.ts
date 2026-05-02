import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAnalysisResult } from './cli.js';
import { extractNamespaces } from './extract-namespaces.js';
import { findCallsites } from './find-callsites.js';
import { generateMarkdown } from './generate-markdown.js';
import { classifyTier, createAnalysisProgram } from './program.js';
import type { AnalysisResult, NamespaceEntry } from './types.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('createAnalysisProgram', () => {
  it('surfaces tsconfig read errors', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'tsconfig.json'), '{', 'utf-8');

    expect(() => createAnalysisProgram(root)).toThrow('Failed to read tsconfig.json');
  });
});

describe('parseAnalysisResult', () => {
  it('throws a controlled error for malformed JSON', () => {
    expect(() => parseAnalysisResult('{')).toThrow('Invalid analysis JSON: Expected property name');
  });

  it('throws a controlled error for non-analysis JSON', () => {
    expect(() => parseAnalysisResult('{"namespaces":{}}')).toThrow(
      'Invalid analysis JSON: Input is not a valid AnalysisResult payload',
    );
  });

  it('throws a controlled error for malformed namespace entries', () => {
    expect(() =>
      parseAnalysisResult('{"analyzedAt":"2026-01-01T00:00:00.000Z","sourceCommit":"abc123","namespaces":[{}]}'),
    ).toThrow('Invalid analysis JSON: Input is not a valid AnalysisResult payload');
  });
});

describe('classifyTier', () => {
  it('classifies non-extension files as framework when the analysis root is the framework distribution', () => {
    expect(classifyTier('/repo/framework/packages/contracts/src/namespace.ts', '/repo/framework')).toBe('framework');
    expect(classifyTier('/repo/framework/extensions/opencode/src/namespace.ts', '/repo/framework')).toBe('extension');
  });
});

describe('extractNamespaces', () => {
  it('extracts subjects from config shorthand schemas', () => {
    const root = createTempProject({
      'namespace.ts': `
        declare function createStorageNamespace(domain: string, config: { schemas: unknown }): unknown;

        const schemas = {
          created: { shape: 'event' },
        };

        export const DemoNamespace = createStorageNamespace('demo', { schemas });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'storage:demo',
        schemaRecordName: 'schemas',
        subjects: [{ key: 'created', wire: 'storage:demo.created', type: 'event' }],
      },
    ]);
  });

  it('resolves subjects from aliased schema imports by local registration name', () => {
    const root = createTempProject({
      'schemas.ts': `
        export const CanonicalSchemas = {
          imported: { shape: 'event' },
        };
      `,
      'namespace.ts': `
        import { CanonicalSchemas as LocalSchemas } from './schemas.js';

        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const AliasNamespace = MakaioBus.registerNamespace('alias', LocalSchemas);
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'alias',
        schemaRecordName: 'LocalSchemas',
        subjects: [{ key: 'imported', wire: 'alias.imported', type: 'event' }],
      },
    ]);
  });

  it('matches direct inline registerNamespace subjects to the namespace prefix', () => {
    const root = createTempProject({
      'namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const FirstNamespace = MakaioBus.registerNamespace('first', {
          firstOnly: { shape: 'event' },
        });

        export const SecondNamespace = MakaioBus.registerNamespace('second', {
          secondOnly: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'first',
        subjects: [{ key: 'firstOnly', wire: 'first.firstOnly', type: 'event' }],
      },
      {
        prefix: 'second',
        subjects: [{ key: 'secondOnly', wire: 'second.secondOnly', type: 'event' }],
      },
    ]);
  });

  it('ignores property registerNamespace calls on non-bus receivers', () => {
    const root = createTempProject({
      'namespace.ts': `
        const Builder = {
          registerNamespace(prefix: string, schemas: unknown): unknown {
            return { prefix, schemas };
          },
        };

        export const BuilderNamespace = Builder.registerNamespace('builder', {
          builderOnly: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toEqual([]);
  });

  it('keeps direct registerNamespace calls supported', () => {
    const root = createTempProject({
      'namespace.ts': `
        declare function registerNamespace(prefix: string, schemas: unknown): unknown;

        export const DirectNamespace = registerNamespace('direct', {
          directOnly: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'direct',
        subjects: [{ key: 'directOnly', wire: 'direct.directOnly', type: 'event' }],
      },
    ]);
  });

  it('can exclude framework namespace definitions for monorepo product docs', () => {
    const root = createTempProject({
      'framework/packages/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const FrameworkNamespace = MakaioBus.registerNamespace('framework.demo', {
          changed: { shape: 'event' },
        });
      `,
      'product/services/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const ProductNamespace = MakaioBus.registerNamespace('product.demo', {
          changed: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root, { excludePathPrefixes: ['framework/'] });

    expect(namespaces.map((ns) => ns.prefix)).toEqual(['product.demo']);
  });

  it('preserves schema origin metadata through local subject wrappers', () => {
    const root = createTempProject({
      'schemas.ts': `
        /** Wrapped schema description. */
        export const WrappedSchema = { shape: 'event' };
      `,
      'namespace.ts': `
        import { WrappedSchema } from './schemas.js';

        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): { subjects: unknown };
        };
        declare function localSubject<T>(schema: T): { __local: true; schema: T };

        export const DemoSchemas = {
          wrapped: localSubject(WrappedSchema),
        };
        export const DemoNamespace = MakaioBus.registerNamespace('demo', DemoSchemas);
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces[0]?.subjects).toMatchObject([
      {
        key: 'wrapped',
        schemaFile: 'schemas.ts',
        description: 'Wrapped schema description.',
      },
    ]);
  });
});

describe('findCallsites', () => {
  it('buckets framework-root callsites as framework callsites', () => {
    const root = createTempProject(
      {
        'namespace.ts': `
          declare const MakaioBus: {
            registerNamespace(prefix: string, schemas: unknown): { subjects: unknown };
          };

          export const DemoNamespace = MakaioBus.registerNamespace('demo', {
            changed: { shape: 'event' },
          });
          export const DemoSubjects = DemoNamespace.subjects;
        `,
        'consumer.ts': `
          import { DemoSubjects } from './namespace.js';

          console.log(DemoSubjects);
        `,
      },
      { directoryName: 'framework' },
    );
    const program = createAnalysisProgram(root);
    const namespaces = extractNamespaces(program, root);

    findCallsites(program, namespaces, root);

    expect(namespaces[0]?.callsites.framework).toEqual(['consumer.ts']);
    expect(namespaces[0]?.callsites.product).toEqual([]);
  });

  it('keeps framework callsites visible for product namespace docs', () => {
    const root = createTempProject({
      'product/services/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): { subjects: unknown };
        };

        export const ProductNamespace = MakaioBus.registerNamespace('product.demo', {
          changed: { shape: 'event' },
        });
        export const ProductSubjects = ProductNamespace.subjects;
      `,
      'framework/packages/consumer.ts': `
        import { ProductSubjects } from '../../product/services/demo/namespace.js';

        console.log(ProductSubjects);
      `,
    });
    const program = createAnalysisProgram(root);
    const namespaces = extractNamespaces(program, root, { excludePathPrefixes: ['framework/'] });

    findCallsites(program, namespaces, root, {
      classifyCallsiteTier: (relativePath) => (relativePath.startsWith('framework/') ? 'framework' : 'product'),
    });

    expect(namespaces[0]?.callsites.framework).toEqual(['framework/packages/consumer.ts']);
  });

  it('uses the host callsite tier classifier instead of inferring monorepo paths', () => {
    const root = createTempProject({
      'product/services/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): { subjects: unknown };
        };

        export const ProductNamespace = MakaioBus.registerNamespace('product.demo', {
          changed: { shape: 'event' },
        });
        export const ProductSubjects = ProductNamespace.subjects;
      `,
      'shared/consumer.ts': `
        import { ProductSubjects } from '../product/services/demo/namespace.js';

        console.log(ProductSubjects);
      `,
    });
    const program = createAnalysisProgram(root);
    const namespaces = extractNamespaces(program, root);

    findCallsites(program, namespaces, root, {
      classifyCallsiteTier: (relativePath) => (relativePath.startsWith('shared/') ? 'framework' : 'product'),
    });

    expect(namespaces[0]?.callsites.framework).toEqual(['shared/consumer.ts']);
    expect(namespaces[0]?.callsites.product).toEqual([]);
  });
});

describe('generateMarkdown', () => {
  it('keeps scoped package filenames distinct', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        createNamespace('@makaio/contracts', 'framework.one'),
        createNamespace('@other/contracts', 'framework.two'),
      ],
    };

    const files = generateMarkdown(analysis, frameworkMarkdownOptions());

    expect(files.map((file) => file.path).sort()).toEqual(['README.md', 'framework-one.md', 'framework-two.md']);
    expect(files.find((file) => file.path === 'README.md')?.content).toContain('./framework-one.md');
    expect(files.find((file) => file.path === 'README.md')?.content).toContain('./framework-two.md');
  });

  it('links framework source files from explicit framework path roots', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        {
          ...createNamespace('@makaio/services-core', 'service.demo', 'packages/services/core/src/namespace.ts'),
          subjects: [
            {
              key: 'changed',
              wire: 'service.demo.changed',
              type: 'event',
              schemaFile: 'packages/services/core/src/schemas.ts',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, frameworkMarkdownOptions()).find(
      (entry) => entry.path === 'services/service-demo.md',
    );

    expect(file?.content).toContain(
      '[`packages/services/core/src/namespace.ts`](../../../packages/services/core/src/namespace.ts)',
    );
    expect(file?.content).toContain('[`schemas.ts`](../../../packages/services/core/src/schemas.ts)');
  });

  it('links monorepo source files from explicit monorepo path roots', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        {
          ...createNamespace('@makaio/services-demo', 'service.demo', 'product/services/demo/src/namespace.ts'),
          tier: 'product',
          subjects: [
            {
              key: 'changed',
              wire: 'service.demo.changed',
              type: 'event',
              schemaFile: 'product/services/src/demo/schemas.ts',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, monorepoMarkdownOptions()).find(
      (entry) => entry.path === 'services/service-demo.md',
    );

    expect(file?.content).toContain(
      '[`product/services/demo/src/namespace.ts`](../../../../product/services/demo/src/namespace.ts)',
    );
    expect(file?.content).toContain('[`schemas.ts`](../../../../product/services/src/demo/schemas.ts)');
  });

  it('renders subject descriptions even when no field table is available', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        {
          ...createNamespace('@makaio/contracts', 'description.demo'),
          subjects: [
            {
              key: 'changed',
              wire: 'description.demo.changed',
              type: 'event',
              description: 'Description without fields.',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, frameworkMarkdownOptions()).find(
      (entry) => entry.path === 'description-demo.md',
    );

    expect(file?.content).toContain('Description without fields.');
  });
});

/**
 * Creates a temporary project root with a minimal package and tsconfig.
 * @param files - Source files to write at the project root.
 * @param options - Optional temporary project layout settings.
 * @returns The temporary project root path.
 */
function createTempProject(files: Record<string, string>, options: { directoryName?: string } = {}): string {
  const tempRoot = createTempRoot();
  const root = options.directoryName ? join(tempRoot, options.directoryName) : tempRoot;

  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/workspace', type: 'module' }), 'utf-8');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        skipLibCheck: true,
      },
      files: Object.keys(files),
    }),
    'utf-8',
  );

  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content, 'utf-8');
  }

  return root;
}

/**
 * Creates and tracks a temporary root for cleanup.
 * @returns The created temporary directory.
 */
function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'namespace-analyzer-'));
  tempRoots.push(root);
  return root;
}

/**
 * Creates a minimal namespace entry for Markdown generation tests.
 * @param packageName - Package name that owns the namespace.
 * @param prefix - Namespace prefix.
 * @param file - Source file path for the namespace.
 * @returns A namespace entry.
 */
function createNamespace(packageName: string, prefix: string, file = `${prefix}.ts`): NamespaceEntry {
  return {
    prefix,
    namespaceConstant: `${prefix}Namespace`,
    subjectsConstant: null,
    schemaRecordName: `${prefix}Schemas`,
    kind: 'bus',
    tier: 'framework',
    definedIn: {
      file,
      package: packageName,
    },
    subjects: [],
    callsites: { framework: [], product: [] },
  };
}

/**
 * Creates framework-doc Markdown options for tests.
 * @returns Markdown options matching the framework package entrypoint.
 */
function frameworkMarkdownOptions(): Parameters<typeof generateMarkdown>[1] {
  return {
    title: 'Bus Subject Namespaces (Framework)',
    docsRoot: 'docs/subjects',
    sourceRoot: '',
    includeTiers: ['framework', 'extension'],
    includeProductCallsites: false,
  };
}

/**
 * Creates monorepo-doc Markdown options for tests.
 * @returns Markdown options matching the root package entrypoint.
 */
function monorepoMarkdownOptions(): Parameters<typeof generateMarkdown>[1] {
  return {
    title: 'Bus Subject Namespaces (Monorepo)',
    docsRoot: 'docs/subjects/generated',
    sourceRoot: '',
    includeProductCallsites: true,
  };
}
