import { describe, expect, it } from 'vitest';
import { buildGenericArtifactView } from '../generic-artifact-view-builder.js';
import { makeRegistration, makeRevision } from './helpers.js';

describe('buildGenericArtifactView', () => {
  it('reads the declared nested title without exposing other data fields', () => {
    const revision = makeRevision({ data: { label: { text: 'Payment rules' }, secret: 'not selected' } });
    const view = buildGenericArtifactView(revision, makeRegistration({ titlePath: 'label.text' }), 'full');
    expect(view.title).toBe('Payment rules');
    expect(view.sections).toEqual([]);
    expect(view.artifact).toEqual({ id: revision.id, kind: revision.kind, revision: revision.revision });
    expect(JSON.stringify(view)).not.toContain('not selected');
  });

  it('rejects a missing readable title instead of silently substituting an identifier', () => {
    expect(() => buildGenericArtifactView(makeRevision({ data: {} }), makeRegistration(), 'link')).toThrow();
    expect(() =>
      buildGenericArtifactView(makeRevision({ data: { title: '  ' } }), makeRegistration(), 'link'),
    ).toThrow();
  });

  it('does not expose a factual status as the artifact lifecycle', () => {
    const view = buildGenericArtifactView(makeRevision(), makeRegistration(), 'full');
    expect(view.artifact).not.toHaveProperty('status');
  });

  it('keeps direct artifact links at all levels and groups them only in full views', () => {
    const revision = makeRevision({
      relations: [
        { type: 'references', target: { refClass: 'artifact', kind: 'rule', id: 'rule-1', revision: 'r1' } },
        { type: 'constrained_by', target: { refClass: 'artifact', kind: 'rule', id: 'rule-1', revision: 'r1' } },
        { type: 'evidenced_by', target: { refClass: 'evidence', kind: 'commit', id: 'sha' } },
      ],
    });
    const compact = buildGenericArtifactView(revision, makeRegistration(), 'summary');
    expect(compact.navigation.related).toEqual([{ artifactId: 'rule-1', label: '[rule] rule-1' }]);
    expect(compact.navigation.breadcrumbs).toEqual([]);
    expect(compact.sections).toEqual([]);
    const full = buildGenericArtifactView(revision, makeRegistration(), 'full');
    expect(full.sections).toEqual([
      {
        type: 'relations',
        title: 'Relations',
        groups: [
          { type: 'references', items: [{ artifactId: 'rule-1', label: '[rule] rule-1' }] },
          { type: 'constrained_by', items: [{ artifactId: 'rule-1', label: '[rule] rule-1' }] },
        ],
      },
    ]);
  });

  it('includes direct confidence evidence only at full level', () => {
    const revision = makeRevision({
      confidence: {
        level: 'verified',
        basis: [
          {
            kind: 'automated-test',
            actor: { kind: 'system', id: 'test' },
            timestamp: 1,
            evidenceRef: { refClass: 'evidence', kind: 'commit', id: 'sha', locator: 'src/rule.ts:12' },
          },
        ],
      },
    });
    const full = buildGenericArtifactView(revision, makeRegistration(), 'full');
    expect(full.sections).toEqual([
      { type: 'evidence', title: 'Evidence', items: [{ kind: 'commit', id: 'sha', locator: 'src/rule.ts:12' }] },
    ]);
    expect(buildGenericArtifactView(revision, makeRegistration(), 'link').sections).toEqual([]);
  });
});
