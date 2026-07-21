import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAnalysisResult } from './cli.js';
import { extractNamespaces } from './extract-namespaces.js';
import { findCallsites } from './find-callsites.js';
import { generateMarkdown } from './generate-markdown.js';
import { isFrameworkDistributionRoot } from './path-utils.js';
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
  it('recognizes the standalone framework workspace package as a framework root', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@makaio/framework-workspace' }));

    expect(isFrameworkDistributionRoot(root)).toBe(true);
    expect(classifyTier(join(root, 'core/contracts/src/namespace.ts'), root)).toBe('framework');
  });

  it('classifies non-extension files as framework when the analysis root is the framework distribution', () => {
    expect(classifyTier('/repo/framework/core/contracts/src/namespace.ts', '/repo/framework')).toBe('framework');
    expect(classifyTier('/repo/framework/extensions/opencode/src/namespace.ts', '/repo/framework')).toBe('extension');
  });

  it('uses host tier policy for non-distribution analysis roots', () => {
    expect(
      classifyTier('/repo/host/web/namespace.ts', '/repo', (relativePath) =>
        relativePath.startsWith('host/web/') ? 'host-web' : 'host',
      ),
    ).toBe('host-web');
  });

  it('keeps framework paths outside the host tier policy', () => {
    expect(classifyTier('/repo/framework/core/contracts/src/namespace.ts', '/repo', () => 'host')).toBe('framework');
    expect(classifyTier('/repo/framework/extensions/opencode/src/namespace.ts', '/repo', () => 'host')).toBe(
      'extension',
    );
  });
});

describe('extractNamespaces', () => {
  it('extracts plain createBusNamespace factory calls', () => {
    const root = createTempProject({
      'namespace.ts': `
        declare function createBusNamespace(domain: string, schemas: unknown): unknown;

        export const DemoNamespace = createBusNamespace('demo', {
          changed: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'demo',
        kind: 'bus',
        subjects: [{ key: 'changed', wire: 'demo.changed', type: 'event' }],
      },
    ]);
  });

  it('extracts createStorageNamespaceDefinition factory calls', () => {
    const root = createTempProject({
      'namespace.ts': `
        declare function createStorageNamespaceDefinition(domain: string, config: { schemas: unknown }): unknown;

        export const DemoStorageNamespace = createStorageNamespaceDefinition('demo', {
          schemas: {
            get: { request: {}, response: {} },
          },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'storage:demo',
        kind: 'storage',
        subjects: [{ key: 'get', wire: 'storage:demo.get', type: 'rpc' }],
      },
    ]);
  });

  it('extracts createContractStorageNamespace factory calls', () => {
    const root = createTempProject({
      'namespace.ts': `
        declare function createContractStorageNamespace(domain: string, config: { schemas: unknown }): unknown;

        export const DemoStorageNamespace = createContractStorageNamespace('demo', {
          schemas: {
            get: { request: {}, response: {} },
          },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces).toMatchObject([
      {
        prefix: 'storage:demo',
        kind: 'storage',
        subjects: [{ key: 'get', wire: 'storage:demo.get', type: 'rpc' }],
      },
    ]);
  });

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

  it('can exclude framework namespace definitions for host docs', () => {
    const root = createTempProject({
      'framework/packages/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const FrameworkNamespace = MakaioBus.registerNamespace('framework.demo', {
          changed: { shape: 'event' },
        });
      `,
      'host/services/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const HostNamespace = MakaioBus.registerNamespace('host.demo', {
          changed: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root, { excludePathPrefixes: ['framework/'] });

    expect(namespaces.map((ns) => ns.prefix)).toEqual(['host.demo']);
  });

  it('applies host namespace tier policy during extraction', () => {
    const root = createTempProject({
      'host/web/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): unknown;
        };

        export const HostNamespace = MakaioBus.registerNamespace('host.web.demo', {
          changed: { shape: 'event' },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root, {
      classifyNamespaceTier: (relativePath) => (relativePath.startsWith('host/web/') ? 'host-web' : 'host'),
    });

    expect(namespaces[0]?.tier).toBe('host-web');
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

  it('includes fields owned by individual response union variants', () => {
    const root = createTempProject({
      'namespace.ts': `
        interface TestSchema<Input, Output> {
          readonly _input: Input;
          readonly _output: Output;
          readonly shape: object;
        }

        declare function createBusNamespace(domain: string, schemas: unknown): unknown;
        declare const RequestSchema: TestSchema<{ ref: string }, { ref: string }>;
        declare const ResponseSchema: TestSchema<
          never,
          | { status: 'ok'; view: { title: string }; builderVersion: number; sourceRevision: string; note?: string }
          | { status: 'not-found'; view: null }
        >;

        export const DemoNamespace = createBusNamespace('demo', {
          resolve: { request: RequestSchema, response: ResponseSchema },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces[0]?.subjects[0]?.response).toEqual([
      { name: 'builderVersion', type: 'number | undefined', required: false },
      { name: 'note', type: 'string | undefined', required: false },
      { name: 'sourceRevision', type: 'string | undefined', required: false },
      { name: 'status', type: '"ok" | "not-found"', required: true },
      { name: 'view', type: '{ title: string; } | null', required: true },
    ]);
  });

  it('deduplicates field type members shared by response union variants', () => {
    const root = createTempProject({
      'namespace.ts': `
        interface TestSchema<Input, Output> {
          readonly _input: Input;
          readonly _output: Output;
          readonly shape: object;
        }

        declare function createBusNamespace(domain: string, schemas: unknown): unknown;
        declare const RequestSchema: TestSchema<Record<string, never>, Record<string, never>>;
        declare const ResponseSchema: TestSchema<
          never,
          | { kind: 'first'; value: string | null }
          | { kind: 'second'; value: null | number }
        >;

        export const DemoNamespace = createBusNamespace('demo', {
          resolve: { request: RequestSchema, response: ResponseSchema },
        });
      `,
    });

    const namespaces = extractNamespaces(createAnalysisProgram(root), root);

    expect(namespaces[0]?.subjects[0]?.response).toEqual([
      { name: 'kind', type: '"first" | "second"', required: true },
      { name: 'value', type: 'string | null | number', required: true },
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
    expect(namespaces[0]?.callsites.host).toEqual([]);
  });

  it('keeps framework callsites visible for host namespace docs', () => {
    const root = createTempProject({
      'host/services/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): { subjects: unknown };
        };

        export const HostNamespace = MakaioBus.registerNamespace('host.demo', {
          changed: { shape: 'event' },
        });
        export const HostSubjects = HostNamespace.subjects;
      `,
      'framework/packages/consumer.ts': `
        import { HostSubjects } from '../../host/services/demo/namespace.js';

        console.log(HostSubjects);
      `,
    });
    const program = createAnalysisProgram(root);
    const namespaces = extractNamespaces(program, root, { excludePathPrefixes: ['framework/'] });

    findCallsites(program, namespaces, root, {
      classifyCallsiteTier: (relativePath) => (relativePath.startsWith('framework/') ? 'framework' : 'host'),
    });

    expect(namespaces[0]?.callsites.framework).toEqual(['framework/packages/consumer.ts']);
  });

  it('uses the host callsite tier classifier instead of inferring workspace paths', () => {
    const root = createTempProject({
      'host/services/demo/namespace.ts': `
        declare const MakaioBus: {
          registerNamespace(prefix: string, schemas: unknown): { subjects: unknown };
        };

        export const HostNamespace = MakaioBus.registerNamespace('host.demo', {
          changed: { shape: 'event' },
        });
        export const HostSubjects = HostNamespace.subjects;
      `,
      'shared/consumer.ts': `
        import { HostSubjects } from '../host/services/demo/namespace.js';

        console.log(HostSubjects);
      `,
    });
    const program = createAnalysisProgram(root);
    const namespaces = extractNamespaces(program, root);

    findCallsites(program, namespaces, root, {
      classifyCallsiteTier: (relativePath) => (relativePath.startsWith('shared/') ? 'framework' : 'host'),
    });

    expect(namespaces[0]?.callsites.framework).toEqual(['shared/consumer.ts']);
    expect(namespaces[0]?.callsites.host).toEqual([]);
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
          ...createNamespace('@makaio/services-core', 'service.demo', 'services/core/src/namespace.ts'),
          subjects: [
            {
              key: 'changed',
              wire: 'service.demo.changed',
              type: 'event',
              schemaFile: 'services/core/src/schemas.ts',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, frameworkMarkdownOptions()).find(
      (entry) => entry.path === 'services/service-demo.md',
    );

    expect(file?.content).toContain('[`services/core/src/namespace.ts`](../../../services/core/src/namespace.ts)');
    expect(file?.content).toContain('[`schemas.ts`](../../../services/core/src/schemas.ts)');
  });

  it('uses absolute source URLs when configured by caller policy', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        {
          ...createNamespace('@makaio/kernel', 'kernel', 'packages/kernel/src/namespace/index.ts'),
          subjects: [
            {
              key: 'boot',
              wire: 'kernel.boot',
              type: 'event',
              schemaFile: 'packages/kernel/src/namespace/schemas.ts',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, {
      ...frameworkMarkdownOptions(),
      sourceBaseUrl: `https://github.com/makaio-ai/makaio-framework/blob/${analysis.sourceCommit}`,
    }).find((entry) => entry.path === 'kernel.md');

    expect(file?.content).toContain(
      'https://github.com/makaio-ai/makaio-framework/blob/abc123/packages/kernel/src/namespace/index.ts',
    );
    expect(file?.content).toContain(
      'https://github.com/makaio-ai/makaio-framework/blob/abc123/packages/kernel/src/namespace/schemas.ts',
    );
  });

  it('keeps relative source links unqualified', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        {
          ...createNamespace('@makaio/kernel', 'kernel', 'packages/kernel/src/namespace/index.ts'),
          subjects: [
            {
              key: 'ready',
              wire: 'kernel.ready',
              type: 'event',
              schemaFile: 'packages/kernel/src/namespace/kernel-schemas.ts',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, {
      ...frameworkMarkdownOptions(),
    }).find((entry) => entry.path === 'kernel.md');

    expect(file?.content).toContain('| Defined in |');
    expect(file?.content).toContain('| Key | Wire | Type | Schema |');
  });

  it('normalizes Windows path separators when composing absolute source URLs', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [createNamespace('@makaio/kernel', 'kernel', String.raw`packages\kernel\src\namespace\index.ts`)],
    };

    const file = generateMarkdown(analysis, {
      ...frameworkMarkdownOptions(),
      sourceBaseUrl: 'https://github.com/makaio-ai/makaio-framework/blob/abc123',
    }).find((entry) => entry.path === 'kernel.md');

    expect(file?.content).toContain(
      'https://github.com/makaio-ai/makaio-framework/blob/abc123/packages/kernel/src/namespace/index.ts',
    );
  });

  it('links host source files from explicit host path roots', () => {
    const analysis: AnalysisResult = {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      sourceCommit: 'abc123',
      namespaces: [
        {
          ...createNamespace('@makaio/services-demo', 'service.demo', 'host/services/demo/src/namespace.ts'),
          tier: 'host',
          subjects: [
            {
              key: 'changed',
              wire: 'service.demo.changed',
              type: 'event',
              schemaFile: 'host/services/src/demo/schemas.ts',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, hostMarkdownOptions()).find(
      (entry) => entry.path === 'services/service-demo.md',
    );

    expect(file?.content).toContain(
      '[`host/services/demo/src/namespace.ts`](../../../../host/services/demo/src/namespace.ts)',
    );
    expect(file?.content).toContain('[`schemas.ts`](../../../../host/services/src/demo/schemas.ts)');
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

  it('injects a missing type line when the source description already includes only a subject line', () => {
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
              description: 'Subject: `description.demo.changed`',
            },
          ],
        },
      ],
    };

    const file = generateMarkdown(analysis, frameworkMarkdownOptions()).find(
      (entry) => entry.path === 'description-demo.md',
    );

    expect(file?.content).toContain('Subject: `description.demo.changed`\n\nType: Event');
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
    callsites: { framework: [], host: [] },
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
    includeHostCallsites: false,
  };
}

/**
 * Creates host-doc Markdown options for tests.
 * @returns Markdown options matching a host package entrypoint.
 */
function hostMarkdownOptions(): Parameters<typeof generateMarkdown>[1] {
  return {
    title: 'Bus Subject Namespaces (Host)',
    docsRoot: 'docs/subjects/generated',
    sourceRoot: '',
    includeHostCallsites: true,
  };
}
