import { describe, expect, it } from 'vitest';
import { createClientDefinition } from '@makaio/contracts/client';

describe('createClientDefinition', () => {
  it('applies schema defaults and freezes the resulting definition', () => {
    const definition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
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
      defaultApprovalPolicy: 'always-ask',
    });

    expect(definition.nativeTools).toEqual([]);
  });
});
