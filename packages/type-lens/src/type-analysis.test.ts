import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TypeAnalyzer } from './type-analysis.js';

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
});
