import type { ZodType } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import type { JsonValue } from '@makaio/contracts';
import {
  LookupCatalogEntrySchema,
  LookupCatalogRequestSchema,
  ReactionCatalogEntrySchema,
  ReactionCatalogRequestSchema,
  RulesSubjects,
  TriggerCatalogEntrySchema,
  TriggerCatalogRequestSchema,
  type LookupCatalogEntry,
  type ReactionRule,
  type RuleCatalogFinding,
  type RuleCheckContext,
  type RuleFinding,
  type RuleValidationFinding,
  type TriggerCatalogEntry,
  type ValidateRulesInput,
} from '@makaio/contracts/rules';
import type { RuleValidationRights } from '../rules/validation-types.js';
import { validateRuleSet } from '../rules/validate-rule-set.js';
import { zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import type { ReactionRegistry } from '../reaction/reaction-registry.js';
import { BaseService } from '@makaio/service-base';
import {
  DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS,
  runContributionCheck,
  validateRuleContributions,
  type CheckLocation,
} from './contribution-validation.js';
import { GroupStrategyRegistry } from './group-strategy-registry.js';
import { LookupRegistry } from './lookup-registry.js';
import { RuleBlockRegistry } from './rule-block-registry.js';
import { TriggerRegistry } from './trigger-registry.js';

/** Catalog entries and projection failures for active contributions. */
type CatalogResult<TEntry> = { entries: TEntry[]; findings: RuleCatalogFinding[] };

/** Host registry ports used to discover and check reactions. */
export type RuleReactionRegistry = Pick<ReactionRegistry, 'listCatalog' | 'ruleDefinition'>;

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
  /** Frozen catalog and check methods shared by extension contexts. */
  private readonly view: RuleContributionsView = Object.freeze({
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
    private readonly reactions: () => RuleReactionRegistry | undefined,
    private readonly isActive: (extension: string) => boolean,
    private readonly validationTimeoutMs = DEFAULT_CONTRIBUTION_VALIDATION_TIMEOUT_MS,
  ) {
    super(bus);
    this.triggers = new TriggerRegistry();
    this.lookups = new LookupRegistry();
    this.groupStrategies = new GroupStrategyRegistry();
    this.ruleBlocks = new RuleBlockRegistry();
  }

  /** @returns Detached catalogs and checks available to extension contexts. */
  public extensionServiceView(): RuleContributionsView {
    return this.view;
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
      { reaction: (kind) => this.reaction(kind)?.validate, lookups: this.lookups, blocks: this.ruleBlocks },
      this.validationTimeoutMs,
    );
  }

  /** Runs a custom check in the fact scope established for that contribution.
   * @param location - Rule identity and contribution location.
   * @param check - The contributed check.
   * @returns Findings with attribution, including timeout and exception findings.
   */
  public checkContribution(
    location: CheckLocation,
    check: () => RuleFinding[] | Promise<RuleFinding[]>,
  ): Promise<RuleValidationFinding[]> {
    return runContributionCheck(location, this.validationTimeoutMs, check);
  }

  /** @returns The host bus whose subject directory rules are checked against. */
  public get validationBus(): IMakaioBus {
    return this.bus;
  }

  /** @param kind - Trigger kind.
   * @returns Active trigger.
   */
  public trigger(kind: string) {
    return this.triggers.listOwned().find(({ extension, entry }) => entry.kind === kind && this.isActive(extension))
      ?.entry;
  }

  /** @param kind - Lookup kind.
   * @returns Active lookup.
   */
  public lookup(kind: string) {
    return this.lookups.listOwned().find(({ extension, entry }) => entry.kind === kind && this.isActive(extension))
      ?.entry;
  }

  /** @param kind - Strategy kind.
   * @returns Active strategy.
   */
  public strategy(kind: string) {
    return this.groupStrategies
      .listOwned()
      .find(({ extension, entry }) => entry.strategy === kind && this.isActive(extension))?.entry;
  }

  /** @param owner - Extension declaring the block.
   * @returns Active rule block.
   */
  public ruleBlock(owner: string) {
    return this.isActive(owner) ? this.ruleBlocks.get(owner) : undefined;
  }

  /** @param kind - Reaction kind.
   * @returns Active reaction's validation and execution metadata.
   */
  public reaction(kind: string) {
    const definition = this.reactions()?.ruleDefinition(kind);
    return definition && this.isActive(definition.extension) ? definition : undefined;
  }

  /** @param rights - Host authorization for validation.
   * @param input - Candidate rule set.
   * @returns Findings for the candidate.
   */
  public validate(rights: RuleValidationRights, input: ValidateRulesInput) {
    return validateRuleSet(this, rights, input);
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
      const owned =
        this.reactions()
          ?.listCatalog()
          .map((entry) => ({ extension: entry.extension, entry })) ?? [];
      ctx.setResult(this.projectCatalog(owned, ReactionCatalogEntrySchema, (_extension, entry) => entry));
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
