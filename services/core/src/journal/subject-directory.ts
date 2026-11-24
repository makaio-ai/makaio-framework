import { matchesSubscription, type IHostMakaioBus } from '@makaio/bus-core';
import {
  SubjectDirectoryNamespace,
  type SubjectDirectoryEntry,
  type SubjectName,
  zodSchemaToJsonRecord,
} from '@makaio/contracts';
import { inspectSubjectSchema, isRequestSchema, type SubjectSchema } from '@makaio/core';
import type {
  ContributionProcessor,
  ExtensionCoordinator,
  KernelExtensionContext,
  KernelMakaioExtension,
} from '@makaio/kernel';
import { BaseService } from '@makaio/service-base';
import { getErrorString } from '@makaio/utils';
import type { z } from 'zod';

type ActivationErrorCode =
  | 'name-not-owned'
  | 'retention-on-request'
  | 'duplicate-subject'
  | 'schema-version-missing'
  | 'retain-on-volatile'
  | 'schema-not-projectable';

/** Invalid subject declaration found while activating an extension. */
export class SubjectActivationError extends Error {
  /**
   * @param code - Machine-readable activation failure.
   * @param extension - Declaring extension.
   * @param subject - Canonical subject name.
   * @param reason - Details of the invalid declaration.
   */
  public constructor(
    public readonly code: ActivationErrorCode,
    public readonly extension: string,
    public readonly subject: string,
    reason: string,
  ) {
    super(`${code}: extension "${extension}", subject "${subject}": ${reason}`);
    this.name = 'SubjectActivationError';
  }
}

type EntryIdentity = Pick<SubjectDirectoryEntry, 'extension' | 'subject'>;
type SchemaProjection = Extract<SubjectDirectoryEntry, { type: 'event' }>['schema'];

/**
 * Project one schema, failing activation when a recorded payload cannot be represented.
 * @param schema - Unwrapped Zod schema.
 * @param entry - Declaring extension and subject.
 * @param direction - Side of the Zod schema exposed by this subject.
 * @param recorded - Whether the declaration requires a JSON Schema projection.
 * @returns A JSON Schema record or an explicit non-projectable mark.
 */
function projectSchema(
  schema: z.ZodType,
  { extension, subject }: EntryIdentity,
  direction: 'input' | 'output',
  recorded = false,
): SchemaProjection {
  try {
    return zodSchemaToJsonRecord(schema, direction);
  } catch (err) {
    const reason = getErrorString(err);
    if (recorded) throw new SubjectActivationError('schema-not-projectable', extension, subject, reason);
    return { projectable: false, reason };
  }
}

/**
 * Project a manifest subject and its journal metadata.
 * @param entry - Declaring extension and subject.
 * @param declaration - Schema defined by the extension.
 * @returns A serialisable subject directory entry.
 */
function projectSubject(entry: EntryIdentity, declaration: SubjectSchema): SubjectDirectoryEntry {
  const { extension, subject } = entry;
  const { schema, marks } = inspectSubjectSchema(declaration);
  const { retention, schemaVersion, readOlder, retainPayload, suggestedFor } = marks.journal ?? {};
  const recorded = retention === 'recorded';
  const request = isRequestSchema(schema);
  const base = {
    ...entry,
    ...(suggestedFor && {
      suggestedFor: {
        ...(suggestedFor.send && { send: [...suggestedFor.send] }),
        ...(suggestedFor.subscribe && { subscribe: [...suggestedFor.subscribe] }),
      },
    }),
  };

  if (request && recorded) {
    throw new SubjectActivationError('retention-on-request', extension, subject, 'Requests are volatile');
  }
  if (!recorded && retainPayload !== undefined) {
    throw new SubjectActivationError('retain-on-volatile', extension, subject, 'retainPayload requires recording');
  }
  if (request) {
    return {
      ...base,
      type: 'request',
      description: schema.request.description ?? schema.response.description ?? subject,
      schema: {
        request: projectSchema(schema.request, entry, 'input'),
        response: projectSchema(schema.response, entry, 'output'),
      },
    };
  }

  if (recorded) {
    const missing = Object.entries({ schemaVersion, readOlder }).find(([, value]) => !value);
    if (missing) {
      throw new SubjectActivationError('schema-version-missing', extension, subject, `Missing ${missing[0]}`);
    }
  }

  return {
    ...base,
    type: 'event',
    description: schema.description ?? subject,
    ...(retention !== undefined && { retention }),
    ...(schemaVersion !== undefined && { schemaVersion }),
    ...(readOlder !== undefined && { readOlder: readOlder.kind }),
    ...(retainPayload !== undefined && { retainPayload }),
    schema: projectSchema(schema, entry, 'input', recorded),
  };
}

/** Read-only directory of the subjects declared by active extensions. */
export class SubjectDirectory extends BaseService implements ContributionProcessor {
  private readonly entries = new Map<
    string,
    { entry: SubjectDirectoryEntry; hasExtension?: KernelExtensionContext['hasExtension'] }
  >();

  /**
   * Create a directory service. Initialize it before starting extensions.
   * @param hostBus - Host bus serving directory requests; the directory registers its namespace there as host.
   * @param coordinator - Coordinator that owns extension activation and namespace claims.
   */
  public constructor(
    private readonly hostBus: IHostMakaioBus,
    private readonly coordinator: ExtensionCoordinator,
  ) {
    super(hostBus);
  }

  /** Register the directory handler and contribution processor. */
  protected onInit(): void {
    const { subjects } = this.hostBus.registerNamespace(SubjectDirectoryNamespace);
    this.registerHandler(subjects.list, ({ payload: { pattern }, setResult }) => {
      const subjects = [...this.entries.values()]
        .filter(
          ({ entry, hasExtension }) =>
            (pattern === undefined || matchesSubscription(entry.subject, pattern)) && hasExtension?.(entry.extension),
        )
        .map(({ entry }) => entry);
      setResult({ subjects: structuredClone(subjects) });
    });
    this.addCleanup(this.coordinator.registerContributionProcessor(this));
    this.addCleanup(() => this.entries.clear());
  }

  /**
   * Select manifests that declare at least one subject.
   * @param pkg - Manifest supplied by the coordinator.
   * @returns Whether this extension contributes directory entries.
   */
  public filter(pkg: KernelMakaioExtension): boolean {
    return pkg.namespaces?.some(({ schemas }) => Object.keys(schemas).length > 0) ?? false;
  }

  /**
   * Read an exact declaration, including one staged before the service starts.
   * @param subject - Canonical subject name.
   * @returns An independent copy of the declaration, if present.
   */
  public stagedSubjectFor(subject: SubjectName): SubjectDirectoryEntry | undefined {
    const staged = this.entries.get(subject);
    return staged && structuredClone(staged.entry);
  }

  /**
   * Preflight and stage all declarations of an extension as one unit.
   * @param name - Declaring extension.
   * @param pkg - Manifest supplied by the coordinator.
   */
  public processActivating(name: string, pkg: KernelMakaioExtension): void {
    if (!pkg.namespaces?.length) return;
    const owners = this.coordinator.namespaceOwners();
    const entries = new Map<string, SubjectDirectoryEntry>();
    for (const { name: domain, schemas } of pkg.namespaces) {
      const owner = owners.ownerOf(domain);
      for (const [key, schema] of Object.entries(schemas)) {
        const subject = `${domain}.${key}`;
        if (owner?.kind !== 'extension' || owner.extension !== name) {
          throw new SubjectActivationError(
            'name-not-owned',
            name,
            subject,
            `Namespace "${domain}" is not owned by the extension`,
          );
        }
        if (entries.has(subject) || this.entries.has(subject)) {
          throw new SubjectActivationError('duplicate-subject', name, subject, 'Subject is declared more than once');
        }
        entries.set(subject, projectSubject({ extension: name, subject }, schema));
      }
    }
    for (const [subject, entry] of entries) {
      this.entries.set(subject, { entry });
    }
  }

  /**
   * Publish staged declarations once the coordinator marks their owner active.
   * @param name - Declaring extension.
   * @param _pkg - Manifest supplied by the coordinator.
   * @param ctx - Extension context providing the live activation check.
   */
  public async processActivated(name: string, _pkg: KernelMakaioExtension, ctx: KernelExtensionContext): Promise<void> {
    for (const staged of this.entries.values()) {
      if (staged.entry.extension === name) staged.hasExtension = ctx.hasExtension;
    }
  }

  /**
   * Remove declarations on stop or when a later activation processor fails.
   * @param name - Extension being stopped or rolled back.
   */
  public async processStopped(name: string): Promise<void> {
    for (const [subject, { entry }] of this.entries) {
      if (entry.extension === name) this.entries.delete(subject);
    }
  }
}
