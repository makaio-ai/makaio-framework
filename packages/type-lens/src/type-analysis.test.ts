import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TypeAnalyzer } from './type-analysis.js';

/**
 * Creates a temporary workspace with a source file and tsconfig.
 * @param source - TypeScript source code.
 * @returns Workspace paths and cleanup function.
 */
function createWorkspace(source: string): {
  workspace: string;
  entryPoint: string;
  tsconfigPath: string;
  cleanup: () => void;
} {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-type-analysis-'));
  const entryPoint = path.join(workspace, 'index.ts');
  const tsconfigPath = path.join(workspace, 'tsconfig.json');

  fs.writeFileSync(entryPoint, source);
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'Bundler',
      },
      files: [entryPoint],
    }),
  );

  return {
    workspace,
    entryPoint,
    tsconfigPath,
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

/**
 * Create a TypeScript program from a workspace tsconfig.
 * @param entryPoint - Source file to use as the root name.
 * @param tsconfigPath - Project configuration path.
 * @returns Configured TypeScript program.
 */
function createProgramFromTsConfig(entryPoint: string, tsconfigPath: string): ts.Program {
  const parsedConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(parsedConfig.config, ts.sys, path.dirname(tsconfigPath));
  return ts.createProgram({
    rootNames: [entryPoint],
    options: config.options,
  });
}

describe('TypeAnalyzer', () => {
  it('resolves utility type composition and the final object shape', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-type-analysis-'));
    const entryPoint = path.join(workspace, 'index.ts');
    const tsconfigPath = path.join(workspace, 'tsconfig.json');

    fs.writeFileSync(
      entryPoint,
      [
        'export interface AgentIdentity {',
        '  /** Unique agent identifier */',
        '  agentId: string;',
        '  adapterId: string;',
        '  adapterName: string;',
        '  adapterSessionId?: string;',
        '}',
        '',
        'export type AgentContext = Required<AgentIdentity>;',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'esnext',
          module: 'esnext',
          moduleResolution: 'Bundler',
        },
        files: [entryPoint],
      }),
    );

    try {
      const analyzer = new TypeAnalyzer({ entryPoints: [entryPoint], tsconfigPath });
      const analysis = analyzer.analyzeExportedTypeAlias('AgentContext');

      expect(analysis?.composition).toEqual({
        text: 'AgentContext',
        symbolName: 'AgentContext',
        children: [
          {
            text: 'Required<AgentIdentity>',
            children: [
              {
                text: 'AgentIdentity',
                symbolName: 'AgentIdentity',
                children: [],
              },
            ],
          },
        ],
      });
      expect(analysis?.resolvedShape).toEqual({
        kind: 'object',
        properties: [
          { name: 'agentId', type: 'string', optional: false },
          { name: 'adapterId', type: 'string', optional: false },
          { name: 'adapterName', type: 'string', optional: false },
          { name: 'adapterSessionId', type: 'string', optional: false },
        ],
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('stops expanding recursive local type graphs at the active symbol path', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-type-analysis-recursive-'));
    const entryPoint = path.join(workspace, 'index.ts');
    const tsconfigPath = path.join(workspace, 'tsconfig.json');

    fs.writeFileSync(
      entryPoint,
      ['export type RecursiveAlias = RecursiveLink;', 'export type RecursiveLink = RecursiveAlias;', ''].join('\n'),
    );
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'esnext',
          module: 'esnext',
          moduleResolution: 'Bundler',
        },
        files: [entryPoint],
      }),
    );

    try {
      const analyzer = new TypeAnalyzer({ entryPoints: [entryPoint], tsconfigPath });
      const analysis = analyzer.analyzeExportedTypeAlias('RecursiveAlias');

      expect(analysis?.composition).toEqual({
        text: 'RecursiveAlias',
        symbolName: 'RecursiveAlias',
        children: [
          {
            text: 'RecursiveLink',
            symbolName: 'RecursiveLink',
            children: [
              {
                text: 'RecursiveAlias',
                symbolName: 'RecursiveAlias',
                children: [],
              },
            ],
          },
        ],
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('analyzes a non-exported type alias via declaration entry point', () => {
    const { entryPoint, tsconfigPath, cleanup } = createWorkspace(
      ['interface InternalBase { id: string; }', 'type LocalAlias = InternalBase & { tag: number; };', ''].join('\n'),
    );

    try {
      const analyzer = new TypeAnalyzer({ entryPoints: [entryPoint], tsconfigPath });
      const analysis = analyzer.analyzeDeclarationAt(entryPoint, 'LocalAlias');

      expect(analysis).toBeDefined();
      expect(analysis!.symbolName).toBe('LocalAlias');
      expect(analysis!.resolvedShape).toEqual({
        kind: 'object',
        properties: [
          { name: 'id', type: 'string', optional: false },
          { name: 'tag', type: 'number', optional: false },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it('analyzes an interface as top-level target, flattening heritage', () => {
    const { entryPoint, tsconfigPath, cleanup } = createWorkspace(
      ['interface Base { a: string; }', 'interface Derived extends Base { b?: number; }', ''].join('\n'),
    );

    try {
      const analyzer = new TypeAnalyzer({ entryPoints: [entryPoint], tsconfigPath });
      const analysis = analyzer.analyzeDeclarationAt(entryPoint, 'Derived');

      expect(analysis).toBeDefined();
      expect(analysis!.symbolName).toBe('Derived');
      expect(analysis!.composition.children).toEqual([
        {
          text: 'Base',
          symbolName: 'Base',
          children: [],
        },
      ]);
      expect(analysis!.resolvedShape).toEqual({
        kind: 'object',
        properties: [
          { name: 'b', type: 'number | undefined', optional: true },
          { name: 'a', type: 'string', optional: false },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it('renders unresolved generic params as-is', () => {
    const { entryPoint, tsconfigPath, cleanup } = createWorkspace(['interface Box<T> { value: T; }', ''].join('\n'));

    try {
      const analyzer = new TypeAnalyzer({ entryPoints: [entryPoint], tsconfigPath });
      const analysis = analyzer.analyzeDeclarationAt(entryPoint, 'Box');

      expect(analysis).toBeDefined();
      expect(analysis!.symbolName).toBe('Box');
      expect(analysis!.resolvedShape).toEqual({
        kind: 'object',
        properties: [{ name: 'value', type: 'T', optional: false }],
      });
    } finally {
      cleanup();
    }
  });

  it('accepts an externally provided program', () => {
    const { entryPoint, tsconfigPath, cleanup } = createWorkspace(
      [
        'export interface AgentIdentity {',
        '  agentId: string;',
        '  adapterId: string;',
        '  adapterName: string;',
        '  adapterSessionId?: string;',
        '}',
        '',
        'export type AgentContext = Required<AgentIdentity>;',
        '',
      ].join('\n'),
    );

    try {
      const program = createProgramFromTsConfig(entryPoint, tsconfigPath);

      const fromProgram = TypeAnalyzer.fromProgram(program);
      const fromOwned = new TypeAnalyzer({ entryPoints: [entryPoint], tsconfigPath });

      const ownedResult = fromOwned.analyzeExportedTypeAlias('AgentContext');
      const programResult = fromProgram.analyzeDeclarationAt(entryPoint, 'AgentContext');

      expect(programResult).toEqual(ownedResult);
    } finally {
      cleanup();
    }
  });

  it('throws when analyzeExportedTypeAlias is called on a fromProgram analyzer', () => {
    const { entryPoint, tsconfigPath, cleanup } = createWorkspace('export type Foo = string;\n');

    try {
      const program = createProgramFromTsConfig(entryPoint, tsconfigPath);

      const analyzer = TypeAnalyzer.fromProgram(program);

      expect(() => analyzer.analyzeExportedTypeAlias('Foo')).toThrow(
        'analyzeExportedTypeAlias requires configured entryPoints',
      );
    } finally {
      cleanup();
    }
  });
});
