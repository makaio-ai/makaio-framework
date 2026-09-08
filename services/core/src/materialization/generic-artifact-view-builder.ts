import { readArtifactTitle } from '@makaio/contracts/artifact';
import type {
  ArtifactKindRegistration,
  ArtifactRelation,
  ArtifactRevision,
  ArtifactViewEvidenceSection,
  ArtifactViewLevel,
  ArtifactViewLink,
  ArtifactViewModel,
  ArtifactViewNavigation,
  ArtifactViewRelationsSection,
  ArtifactViewSection,
} from '@makaio/contracts';

/** Version stamp for the generic artifact view skeleton. */
export const GENERIC_ARTIFACT_VIEW_BUILDER_VERSION = 5;

type DirectArtifactViewLink = ArtifactViewLink & { artifactId: string };

/**
 * Project a direct artifact relation target into a stable view link.
 * @param relation - Relation whose target may reference an artifact.
 * @returns A projected artifact link, or `undefined` for non-artifact targets.
 */
function projectDirectArtifactLink(relation: ArtifactRelation): DirectArtifactViewLink | undefined {
  if (relation.target.refClass !== 'artifact') return undefined;
  return {
    artifactId: relation.target.id,
    label: `[${relation.target.kind}] ${relation.target.id}`,
  };
}

/**
 * Build a relations section from the artifact's direct relations.
 *
 * Only artifact-class relations (refClass `'artifact'`) are included.
 * Relations are grouped by type.
 * @param relations - The artifact's typed relations.
 * @returns A relations section, or `undefined` if there are no artifact relations.
 */
function buildRelationsSection(relations: readonly ArtifactRelation[]): ArtifactViewRelationsSection | undefined {
  const groupMap = new Map<string, Array<{ artifactId?: string; url?: string; label: string }>>();

  for (const relation of relations) {
    const link = projectDirectArtifactLink(relation);
    if (!link) continue;

    const items = groupMap.get(relation.type) ?? [];
    items.push(link);
    groupMap.set(relation.type, items);
  }

  if (groupMap.size === 0) return undefined;

  const groups = [...groupMap.entries()].map(([type, items]) => ({
    type,
    items,
  }));

  return {
    type: 'relations',
    title: 'Relations',
    groups,
  };
}

/**
 * Build deterministic navigation from direct artifact relations.
 *
 * Direct relations are already present on the resolved revision, so this
 * projection performs no additional reads. Breadcrumbs remain empty because
 * only kind-specific builders can assign breadcrumb semantics.
 * @param relations - Direct relations on the resolved artifact revision.
 * @returns Generic breadcrumb and related-link navigation.
 */
function buildNavigation(relations: readonly ArtifactRelation[]): ArtifactViewNavigation {
  const related: ArtifactViewNavigation['related'] = [];
  // ArtifactViewLink addresses one globally stable artifactId. Kind and
  // revision validate and describe exact refs, but do not scope that identity.
  const seenArtifactIds = new Set<string>();

  for (const relation of relations) {
    const link = projectDirectArtifactLink(relation);
    if (!link || seenArtifactIds.has(link.artifactId)) continue;
    seenArtifactIds.add(link.artifactId);

    related.push(link);
  }

  return { breadcrumbs: [], related };
}

/**
 * Build an evidence section from the artifact's confidence basis.
 *
 * Only basis entries with an `evidenceRef` whose refClass is `'evidence'`
 * contribute items.
 * @param revision - The artifact revision.
 * @returns An evidence section, or `undefined` if there are no evidence refs.
 */
function buildEvidenceSection(revision: ArtifactRevision): ArtifactViewEvidenceSection | undefined {
  if (!revision.confidence?.basis) return undefined;

  const items: ArtifactViewEvidenceSection['items'] = [];

  for (const basis of revision.confidence.basis) {
    const ref = basis.evidenceRef;
    if (ref?.refClass !== 'evidence') continue;

    items.push({
      kind: ref.kind,
      id: ref.id,
      ...(ref.locator ? { locator: ref.locator } : {}),
    });
  }

  if (items.length === 0) return undefined;

  return {
    type: 'evidence',
    title: 'Evidence',
    items,
  };
}

/**
 * Build a provider-neutral skeleton for an explicitly registered view builder.
 *
 * Reads only the declared title, direct relations, and direct evidence. No
 * artifact data fields are selected implicitly after retirement of kind-level
 * projection declarations. Named views and context selection are separate work.
 * @param revision - Exact artifact revision to describe.
 * @param registration - Kind registration containing its title contract.
 * @param level - Requested detail level.
 * @returns The title, identity, and direct navigation/evidence skeleton.
 */
export function buildGenericArtifactView(
  revision: ArtifactRevision,
  registration: ArtifactKindRegistration,
  level: ArtifactViewLevel,
): ArtifactViewModel {
  const sections: ArtifactViewSection[] = [];
  if (level === 'full') {
    const relations = buildRelationsSection(revision.relations);
    if (relations) sections.push(relations);
    const evidence = buildEvidenceSection(revision);
    if (evidence) sections.push(evidence);
  }
  return {
    title: readArtifactTitle(revision.data, registration.titlePath),
    artifact: { id: revision.id, kind: revision.kind, revision: revision.revision },
    navigation: buildNavigation(revision.relations),
    sections,
    links: {},
  };
}
