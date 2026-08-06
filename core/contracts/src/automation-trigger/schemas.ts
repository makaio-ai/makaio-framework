import { z } from 'zod';
import { JsonRecordSchema, JsonSchemaRecordSchema } from '../shared/json-value.js';

/**
 * Canonical automation trigger kind schema.
 *
 * Kinds follow either `<extension-name>.<local-name>` or
 * `@<scope>/<extension-name>.<local-name>`, using dot-separated lowercase
 * local-name segments. Colon-separated aliases are explicitly rejected so every
 * registered kind shares the same canonical form.
 *
 * Regex breakdown:
 * - `[a-z0-9-]+` — unscoped extension name: lowercase alphanumeric and hyphens
 * - `@<npm-name-component>/<npm-name-component>` — npm-scoped extension owner
 *   components, which may start with a hyphen and contain dots or underscores
 * - `(?:\.[-a-z0-9_]+)+` — one or more local-name segments allowing hyphens
 *   and underscores
 *
 * Examples: `makaio.profile-changed`, `coderabbit.review-posted`,
 * `makaio.clients-core.profile-changed`, `@acme/review.review-posted`,
 * `@acme.inc/review_tools.review-posted`
 */
const NPM_PACKAGE_NAME_COMPONENT_PATTERN = '(?:[a-z0-9-]|[a-z0-9-][a-z0-9._-]*[a-z0-9_-])';
const AUTOMATION_TRIGGER_LOCAL_NAME_PATTERN = '[-a-z0-9_]+(?:\\.[-a-z0-9_]+)*';

/** Dot-separated local portion of an automation trigger kind. */
export const AutomationTriggerLocalNameSchema = z
  .string()
  .regex(new RegExp(`^${AUTOMATION_TRIGGER_LOCAL_NAME_PATTERN}$`));

export const AutomationTriggerKindSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:[a-z0-9-]+|@${NPM_PACKAGE_NAME_COMPONENT_PATTERN}\\/${NPM_PACKAGE_NAME_COMPONENT_PATTERN})\\.${AUTOMATION_TRIGGER_LOCAL_NAME_PATTERN}$`,
    ),
  );

/**
 * Serializable descriptor advertising a contributed automation trigger.
 *
 * Carries only discoverable metadata and derived JSON Schema representations of
 * the parameter and event shapes. The live Zod schemas and activate function are
 * never serialized — runtime truth is always the live {@link AutomationTriggerType}
 * contributed by the owning extension.
 */
export const AutomationTriggerDescriptorSchema = z.object({
  /**
   * Canonical trigger kind: `<extension-name>.<local-name>` or
   * `@<scope>/<extension-name>.<local-name>`.
   * Namespace enforcement happens in the trigger registry.
   */
  kind: AutomationTriggerKindSchema,
  /** Human-readable label shown in the Builder UI. */
  label: z.string().min(1),
  /** Human-readable description of what this trigger emits and when. */
  description: z.string(),
  /** Categorization tags for grouping triggers in the Builder UI. */
  categories: z.array(z.string()).readonly(),
  /**
   * Derived JSON Schema representation of the trigger's parameter shape.
   *
   * Produced from the live Zod `paramsSchema` with the `$schema` dialect
   * marker stripped. Consumers use this for discovery and form rendering;
   * runtime validation always uses the live Zod schema.
   */
  parameterSchema: JsonSchemaRecordSchema,
  /**
   * Derived JSON Schema representation of the trigger's emitted event shape.
   *
   * Produced from the live Zod `eventSchema` with the `$schema` dialect
   * marker stripped.
   */
  eventSchema: JsonSchemaRecordSchema,
  /**
   * Whether the event output can be consumed as a workflow trigger payload.
   *
   * Derived from the output JSON Schema by
   * {@link createAutomationTriggerDescriptor}; contributors cannot override it.
   * Generic automation trigger consumers remain free to consume any JSON value.
   */
  workflowCompatible: z.boolean(),
});

/** Serializable descriptor advertising a contributed automation trigger. */
export type AutomationTriggerDescriptor = z.infer<typeof AutomationTriggerDescriptorSchema>;

/**
 * Serializable binding reference linking an active automation trigger to its
 * configuration parameters.
 *
 * Validated as a JSON-safe record so bindings stay serializable and can be
 * persisted in workflow definitions.
 */
export const AutomationTriggerBindingSchema = z.object({
  /**
   * Canonical trigger kind: `<extension-name>.<local-name>` or
   * `@<scope>/<extension-name>.<local-name>`.
   * Must satisfy {@link AutomationTriggerKindSchema}.
   */
  kind: AutomationTriggerKindSchema,
  /**
   * JSON-compatible parameter values for the trigger binding.
   *
   * Validated as a `Record<string, JsonValue>` to keep the binding
   * serializable. Uses {@link JsonRecordSchema} rather than the similar-looking
   * {@link JsonSchemaRecordSchema}, which semantically means "a JSON Schema
   * document" and is used for `parameterSchema`/`eventSchema` descriptor fields.
   */
  params: JsonRecordSchema,
});
