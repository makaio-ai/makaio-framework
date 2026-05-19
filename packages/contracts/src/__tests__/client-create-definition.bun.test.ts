import { describe, expect, it } from 'bun:test';
import { createClientDefinition } from '@makaio/contracts/client';

describe('createClientDefinition', () => {
  it('applies schema defaults and freezes the resulting definition', () => {
    const definition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
      version: '0.1.0',
      defaultApprovalPolicy: 'full-access',
      nativeTools: [
        {
          name: 'bash',
          friendlyName: 'Terminal',
          capabilities: [],
        },
      ],
    });

    expect(definition.nativeTools).toHaveLength(1);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.nativeTools)).toBe(true);
    expect(Object.isFrozen(definition.nativeTools[0]!)).toBe(true);
    expect(() =>
      definition.nativeTools.push({
        name: 'patch',
        friendlyName: 'Patch File',
        capabilities: [],
      }),
    ).toThrow(TypeError);
  });

  it('applies schema defaults while normalizing the exported shape', () => {
    const definition = createClientDefinition({
      id: 'claude-code',
      name: 'Claude Code',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
    });

    expect(definition.nativeTools).toEqual([]);
  });
});
