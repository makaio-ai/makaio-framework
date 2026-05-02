import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TypeAliasAnalysis } from '@makaio/type-lens/type-analysis';
import { augmentTypeAliasPageWithAnalysis, rewriteTypeDocSymbolLinks } from './generate-api-reference';

describe('augmentTypeAliasPageWithAnalysis', () => {
  it('adds linked composition and resolved shape sections to TypeDoc type alias pages', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-api-analysis-'));
    const pagePath = path.join(workspace, 'AgentContext.md');
    const analysis: TypeAliasAnalysis = {
      symbolName: 'AgentContext',
      composition: {
        text: 'AgentContext',
        symbolName: 'AgentContext',
        children: [
          {
            text: 'Required<AgentIdentity>',
            children: [{ text: 'AgentIdentity', symbolName: 'AgentIdentity', children: [] }],
          },
        ],
      },
      resolvedShape: {
        kind: 'object',
        properties: [
          { name: 'agentId', type: 'string', optional: false },
          { name: 'adapterSessionId', type: 'string', optional: false },
        ],
      },
    };

    fs.writeFileSync(
      pagePath,
      [
        '---',
        'title: "Type Alias: AgentContext"',
        '---',
        '',
        '# Type Alias: AgentContext',
        '',
        '> **AgentContext** = `Required`\\<`AgentIdentity`\\>',
        '',
      ].join('\n'),
    );

    try {
      augmentTypeAliasPageWithAnalysis(pagePath, analysis, {
        AgentContext: '/reference/api/ai-adapters-core/type-aliases/agentcontext/',
        AgentIdentity: '/reference/api/ai-adapters-core/interfaces/agentidentity/',
      });

      const result = fs.readFileSync(pagePath, 'utf-8');
      expect(result).toContain('## Type Composition');
      expect(result).toContain('- [`AgentContext`](/reference/api/ai-adapters-core/type-aliases/agentcontext/)');
      expect(result).toContain('  - `Required<AgentIdentity>`');
      expect(result).toContain('    - [`AgentIdentity`](/reference/api/ai-adapters-core/interfaces/agentidentity/)');
      expect(result).toContain('## Resolved Shape');
      expect(result).toContain('type AgentContext = {');
      expect(result).toContain('  agentId: string;');
      expect(result).toContain('  adapterSessionId: string;');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('rewriteTypeDocSymbolLinks', () => {
  it('rewrites TypeDoc relative symbol links to canonical website routes', () => {
    expect(
      rewriteTypeDocSymbolLinks(
        '> **AgentContext** = `Required`\\<[`AgentIdentity`](../interfaces/AgentIdentity.md)\\>',
        {
          AgentIdentity: '/reference/api/ai-adapters-core/interfaces/agentidentity/',
        },
      ),
    ).toBe(
      '> **AgentContext** = `Required`\\<[`AgentIdentity`](/reference/api/ai-adapters-core/interfaces/agentidentity/)\\>',
    );
  });

  it('resolves relative links from the generated page path when available', () => {
    const outputDir = path.join('docs', 'reference', 'api');
    const pagePath = path.join(outputDir, 'ai-adapters-core', 'type-aliases', 'AgentContext.md');

    expect(
      rewriteTypeDocSymbolLinks(
        '[`AgentIdentity`](../interfaces/AgentIdentity.md)',
        {
          AgentIdentity: '/reference/api/wrong-package/interfaces/agentidentity/',
        },
        { pagePath, outputDir },
      ),
    ).toBe('[`AgentIdentity`](/reference/api/ai-adapters-core/interfaces/agentidentity/)');
  });
});
