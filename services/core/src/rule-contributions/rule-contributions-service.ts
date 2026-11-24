import type { ZodType } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue } from '@makaio/contracts';
import {
  LookupCatalogEntrySchema,
  LookupCatalogRequestSchema,
  ReactionCatalogRequestSchema,
  RulesSubjects,
  TriggerCatalogEntrySchema,
  TriggerCatalogRequestSchema,
  type LookupCatalogEntry,
  type ReactionRule,
  type RuleCatalogFinding,
  type RuleCheckContext,
  type RuleValidationFinding,
  type TriggerCatalogEntry,
} from '@makaio/contracts/rules';
import { zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import type { ReactionRegistryView } from '../reaction/reaction-registry.js';
import { BaseService } from '@makaio/service-base';
import { DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS, validateRuleContributions } from './contribution-validation.js';
import { GroupStrategyRegistry } from './group-strategy-registry.js';
import { LookupRegistry } from './lookup-registry.js';
import { RuleBlockRegistry } from './rule-block-registry.js';
import { TriggerRegistry } from './trigger-registry.js';

/** Catalog entries and projection failures for active contributions. */
type CatalogResult<TEntry> = { entries: TEntry[]; findings: RuleCatalogFinding[] };

/** Rule discovery and contribution checks available to extension contexts. */
export type RuleContributionsView = Readonly<
  Pick<RuleContributionsService, 'listTriggers' | 'listLookups' | 'validateRuleContributions'>
>;

/**
 * Service that hosts the rule contribution registries: triggers, lookups,
 * group strategies and rule blocks.
 *
 * The contribution processor registers declarations here. The service exposes
 * their catalogs and runs their custom checks for the host's rule validator.
 */
export class RuleContributionsService extends BaseService {
  /** Exposes detached catalogs and checks while keeping the registries host-owned. */
  public readonly extensionServiceView: RuleContributionsView = Object.freeze({
    listTriggers: this.listTriggers.bind(this),
    listLookups: this.listLookups.bind(this),
    validateRuleContributions: this.validateRuleContributions.bind(this),
  });

  /** Registry of contributed triggers. */
  public readonly triggers: TriggerRegistry;
  /** Registry of contributed lookups. */
  public readonly lookups: LookupRegistry;
  /** Registry of contributed group strategies. */
  public readonly groupStrategies: GroupStrategyRegistry;
  /** Registry of contributed rule blocks, one per extension at most. */
  public readonly ruleBlocks: RuleBlockRegistry;

  /**
   * @param bus - Bus instance used for the service lifecycle.
   * @param reactions - Resolves the active reaction registry.
   * @param isActive - Reports whether a contributor completed activation.
   * @param validationTimeoutMs - Deadline in milliseconds for each custom rule check.
   */
  public constructor(
    bus: IMakaioBus,
    private readonly reactions: () => ReactionRegistryView | undefined,
    private readonly isActive: (extension: string) => boolean,
    private readonly validationTimeoutMs = DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS,
  ) {
    super(bus);
    this.triggers = new TriggerRegistry();
    this.lookups = new LookupRegistry();
    this.groupStrategies = new GroupStrategyRegistry();
    this.ruleBlocks = new RuleBlockRegistry();
  }

  /**
   * Runs the custom checks declared for a rule's contributions.
   * @param rule - A structurally checked rule with schema-checked extension blocks.
   * @param ctx - The host's validation context for the rule.
   * @returns Findings from the custom checks, including any host-reported failures.
   */
  public validateRuleContributions(rule: ReactionRule, ctx: RuleCheckContext): Promise<RuleValidationFinding[]> {
    return validateRuleContributions(
      rule,
      ctx,
      { reaction: (kind) => this.reactions()?.getValidator(kind), lookups: this.lookups, blocks: this.ruleBlocks },
      this.validationTimeoutMs,
    );
  }

  /** Binds the catalogs to the bus for the lifetime of the service. */
  protected onInit(): void {
    this.registerHandler(RulesSubjects.triggers, (ctx) => {
      const { catalogContext } = TriggerCatalogRequestSchema.parse(ctx.payload);
      ctx.setResult(this.listTriggers(catalogContext));
    });
    this.registerHandler(RulesSubjects.lookups, (ctx) => {
      const { catalogContext } = LookupCatalogRequestSchema.parse(ctx.payload);
      ctx.setResult(this.listLookups(catalogContext));
    });
    this.registerHandler(RulesSubjects.reactions, (ctx) => {
      ReactionCatalogRequestSchema.parse(ctx.payload);
      const entries =
        this.reactions()
          ?.listCatalog()
          .filter(({ extension }) => this.isActive(extension)) ?? [];
      ctx.setResult({ entries });
    });
  }

  /**
   * Builds a catalog from the live trigger registrations.
   * @param catalogContext - Context forwarded to each facts schema.
   * @returns The current trigger catalog.
   */
  public listTriggers(catalogContext?: JsonValue): CatalogResult<TriggerCatalogEntry> {
    return this.projectCatalog(this.triggers.listOwned(), TriggerCatalogEntrySchema, (extension, entry) => ({
      extension,
      kind: entry.kind,
      description: entry.description,
      params: entry.params ? zodSchemaToJsonRecord(entry.params, 'input') : null,
      facts: entry.facts(undefined, catalogContext),
      subjects: entry.subjects(undefined),
    }));
  }

  /**
   * Builds a catalog from the live lookup registrations.
   * @param catalogContext - Context forwarded to each answer schema.
   * @returns The current lookup catalog.
   */
  public listLookups(catalogContext?: JsonValue): CatalogResult<LookupCatalogEntry> {
    return this.projectCatalog(this.lookups.listOwned(), LookupCatalogEntrySchema, (extension, entry) => ({
      extension,
      kind: entry.kind,
      description: entry.description,
      args: zodSchemaToJsonRecord(entry.args, 'input'),
      answer: entry.answer(undefined, { roots: {}, ...(catalogContext === undefined ? {} : { catalogContext }) }),
      acceptsWhere: entry.where !== undefined,
    }));
  }

  /**
   * Projects active contributions independently so one failure cannot hide healthy entries.
   * @param owned - Contributions paired with their owners.
   * @param schema - Validates and detaches the projected entry.
   * @param project - Derives one catalog entry from an owned contribution.
   * @returns Healthy entries and one finding for each failed projection.
   */
  private projectCatalog<T extends { kind: string }, TEntry>(
    owned: ReadonlyArray<{ extension: string; entry: T }>,
    schema: ZodType<TEntry>,
    project: (extension: string, entry: T) => TEntry,
  ): CatalogResult<TEntry> {
    const result: CatalogResult<TEntry> = { entries: [], findings: [] };
    for (const { extension, entry } of owned) {
      if (!this.isActive(extension)) continue;
      try {
        result.entries.push(schema.parse(project(extension, entry)));
      } catch {
        result.findings.push({
          code: 'catalog-contribution-failed',
          extension,
          kind: entry.kind,
          message: `Could not derive the catalog entry for '${entry.kind}'.`,
        });
      }
    }
    return result;
  }

  /** Clears every registry so contributed closures are released on teardown. */
  protected override onDestroy(): void {
    this.triggers.clear();
    this.lookups.clear();
    this.groupStrategies.clear();
    this.ruleBlocks.clear();
  }
}
