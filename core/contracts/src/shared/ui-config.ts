import { z } from 'zod';

// ─────────────────────────────────────────────────────────
// Widget Types (extensible via declaration merging)
// ─────────────────────────────────────────────────────────

/**
 * Builtin widget types provided by the UI components package
 * - tags: Comma-separated input that converts to array
 * - textarea-array: Multi-line textarea that converts to array
 * - password: Password input field
 * - slider: Numeric slider input
 * - capability-picker: Grouped three-state capability selector with raw tool overrides
 * - prompt-editor: Multi-line textarea with `{{prompt:name}}` template reference highlighting
 */
export type BuiltinWidget = 'tags' | 'textarea-array' | 'password' | 'slider' | 'capability-picker' | 'prompt-editor';

/**
 * Plugin widget registry - augment to add custom widgets.
 * @example Augmenting from a plugin
 * ```typescript
 * // extensions/my-extension/src/types.ts
 * declare module '@makaio/contracts' {
 *   interface PluginWidgetRegistry {
 *     'star-rating': true;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty interface for declaration merging
export interface PluginWidgetRegistry {}

/**
 * All available widget types (builtin + plugin-registered)
 */
export type FieldWidget = BuiltinWidget | keyof PluginWidgetRegistry;

// ─────────────────────────────────────────────────────────
// Shared Option Schema
// ─────────────────────────────────────────────────────────

/**
 * Option for select-type fields.
 *
 * Each option represents a selectable choice in dropdown/select fields.
 */
export const FieldOptionSchema = z.object({
  /** The value to be stored when this option is selected. */
  value: z.string(),
  /** The display label for this option. */
  label: z.string(),
});

/**
 * Option for select-type fields.
 *
 * Each option represents a selectable choice in dropdown/select fields.
 */
export type FieldOption = z.infer<typeof FieldOptionSchema>;

// ─────────────────────────────────────────────────────────
// Field Override Schema
// ─────────────────────────────────────────────────────────

/**
 * Zod schema for field override (runtime validation - accepts any string for widget)
 */
export const FieldOverrideSchema = z
  .object({
    /**
     * Custom widget to use for this field
     * Runtime accepts any string, but type-safe code should use FieldWidget
     */
    widget: z.string().optional(),
    /**
     * Delimiter for splitting array input (default varies by widget)
     */
    delimiter: z.string().optional(),
    /**
     * Placeholder text for empty fields
     */
    placeholder: z.string().optional(),
    /**
     * Help text displayed near the field.
     * Applied UI field definitions expose this value via `FieldDefinition.description`.
     */
    helpText: z.string().optional(),
    /**
     * Minimum value for slider widget
     */
    min: z.number().finite().optional(),
    /**
     * Maximum value for slider widget
     */
    max: z.number().finite().optional(),
    /**
     * Step increment for slider widget
     */
    step: z.number().finite().positive().optional(),
    /**
     * Options for select-type fields
     */
    options: z.array(FieldOptionSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`min` must be less than or equal to `max`',
        path: ['min'],
      });
    }
  });

/**
 * Field override type - inferred from schema
 * Note: widget is string at runtime, use FieldWidget type for type-safe code
 */
export type FieldOverride = z.infer<typeof FieldOverrideSchema>;

// ─────────────────────────────────────────────────────────
// Entity UI Config (uses extracted types)
// ─────────────────────────────────────────────────────────

/**
 * UI configuration for entity forms
 * Defines how the entity should be displayed and edited in the UI
 */
export const EntityUIConfigSchema = z.object({
  /**
   * The editing mode for this entity
   * - inline: Edit directly in the list/card
   * - slidePanel: Edit in a slide-out panel
   * - fullPage: Edit on a dedicated full page
   */
  editMode: z.enum(['inline', 'slidePanel', 'fullPage']).default('fullPage'),
  /**
   * Fields to hide from the form UI
   * These fields will not be rendered and cannot be edited
   */
  hiddenFields: z.array(z.string()).optional(),
  /**
   * Fields that are read-only in edit mode
   * These fields are visible but cannot be modified during editing
   */
  readOnlyInEditMode: z.array(z.string()).optional(),
  /**
   * Field-specific overrides for custom widgets and behavior
   * Maps field name to widget configuration
   */
  fieldOverrides: z.record(z.string(), FieldOverrideSchema).optional(),
  /**
   * Optional form sections for grouping related fields.
   * When provided, fields are rendered in the given section order.
   */
  sections: z
    .array(
      z.object({
        /** Stable identifier for the section */
        id: z.string(),
        /** Display title for the section */
        title: z.string(),
        /** Optional descriptive text shown under the title */
        description: z.string().optional(),
        /** Field keys to include in this section */
        fields: z.array(z.string()),
      }),
    )
    .optional(),
});

/**
 * Entity UI configuration type - inferred from schema
 * Note: widget values are string at runtime, use FieldWidget type for type-safe widget handling
 */
export type EntityUIConfig = z.infer<typeof EntityUIConfigSchema>;

// ─────────────────────────────────────────────────────────
// Form Field Types (shared between framework and host UI)
// ─────────────────────────────────────────────────────────

/**
 * Field type options for form inputs.
 *
 * These types correspond to standard HTML input types and provide
 * type-safe rendering of different form field variants. Slider-style numeric
 * controls continue to use `type: 'number'` with `widget: 'slider'`.
 *
 * Use `'custom'` when field rendering is fully delegated to the widget
 * specified in `widget` — the host-owned form layout routes the field to the
 * registered widget and ignores the type for rendering purposes.
 */
export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'array' | 'custom';

/**
 * Shared properties for all form field definitions.
 *
 * This interface provides the seam for extensible form generation.
 * Fields can be generated from JSON Schema, hardcoded registries,
 * or any other source that can produce this structure.
 */
export interface BaseFieldDefinition {
  /** Unique key for the field (used as form field name). */
  key: string;
  /** Display label for the field. */
  label: string;
  /** Delimiter for array-type fields (default varies by widget). */
  delimiter?: string;
  /** Minimum numeric value (for numeric fields, including the slider widget). */
  min?: number;
  /** Maximum numeric value (for numeric fields, including the slider widget). */
  max?: number;
  /** Step increment for numeric fields, including the slider widget. */
  step?: number;
  /** Placeholder text for text-based inputs. */
  placeholder?: string;
  /** Help text/description shown below the input, including mapped override help text. */
  description?: string;
  /** Whether the field is required. */
  required?: boolean;
  /** Options for select-type fields. */
  options?: FieldOption[];
  /** Default value for the field. */
  defaultValue?: unknown;
  /** Whether the field is disabled. */
  disabled?: boolean;
}

/** Field definition for builtin field types. */
export interface StandardFieldDefinition extends BaseFieldDefinition {
  /** Type of input to render. */
  type: Exclude<FieldType, 'custom'>;
  /** Custom widget for specialized rendering (e.g., tags for arrays). */
  widget?: FieldWidget;
}

/** Field definition for widgets that render through the custom field path. */
export interface CustomFieldDefinition extends BaseFieldDefinition {
  /** Custom fields always render through an explicit widget. */
  type: 'custom';
  /** Builtin or plugin-registered widget used to render the custom field. */
  widget: FieldWidget;
}

/**
 * Definition for a form field.
 *
 * Builtin field types may omit `widget` and fall back to their type renderer.
 * Custom field types must provide a registered widget so render-time lookup
 * never falls back to the literal `'custom'` type.
 */
export type FieldDefinition = StandardFieldDefinition | CustomFieldDefinition;

/**
 * Props for form field components.
 *
 * Defines the contract between the form rendering infrastructure and
 * individual field components. Both framework extensions and host UI
 * implement components that accept this interface.
 *
 * ### Control id contract
 *
 * The host-owned form layout/shell owns label rendering for single-control
 * field types: it sets {@link controlId} and targets it with
 * `<label htmlFor>`. Components **must** set this id on their focusable
 * control (`id={controlId ?? inputId ?? field.key}`, where `inputId` is a
 * component-local prop some field components additionally accept for
 * standalone usage without a shell); a component that ignores `controlId`
 * renders with a dangling `htmlFor` and an unlabelled control. Composite
 * field types, which render more than one control and therefore have no
 * single element `controlId` could target, opt out by declaring
 * `composite: true` in their `ExtensionFieldTypeRegistration` contribution
 * metadata and are named through `aria-labelledby` on a wrapping group
 * instead — the shell does not set `controlId` for those field types.
 *
 * ### Error ownership
 *
 * Components render their control only; the validation error message,
 * like the label and description, belongs to the owning form layout. A
 * component therefore receives the invalid *state* ({@link invalid}) and the
 * id of the message element ({@link describedById}), never the message text
 * — a component that rendered the text as well would display and announce
 * the same error twice.
 * @param field - Field definition describing what to render
 * @param value - Current value of the field
 * @param onChange - Callback when the field value changes
 * @param className - Optional additional CSS class
 * @param idPrefix - Namespace supplied by the owning form layout that every id the component generates internally must carry
 * @param controlId - Id the component must set on its focusable control, when supplied by the owning form layout
 * @param invalid - Whether the control should render as invalid for assistive technology
 * @param describedById - Id(s) of the element(s) that describe this control, forwarded to the control's `aria-describedby`
 */
export interface FormFieldProps {
  /** Field definition describing what to render. */
  field: FieldDefinition;
  /** Current value of the field. */
  value: unknown;
  /** Callback when the field value changes. */
  onChange: (value: unknown) => void;
  /** Optional additional CSS class. */
  className?: string;
  /**
   * Namespace every DOM id this component generates internally must carry.
   *
   * Supplied by the owning form layout, which derives it from its own form
   * instance, so two layouts rendering the same field definitions on one
   * page never produce colliding ids. A component that generates ids of its
   * own — a composite field naming its sub-controls, for instance — must
   * scope them under this prefix *and* the field key, or those ids collide
   * across instances even though the shell's own ids do not.
   *
   * The prefix is used verbatim, so it is already a valid id fragment
   * (no whitespace). Anything the component appends to it is not: field
   * keys and option values are arbitrary strings, where a raw space would
   * split one id into two dangling references in an
   * `aria-labelledby`/`aria-describedby` IDREF list, and an unescaped
   * separator would blur the boundary between id segments. Components
   * therefore compose ids through the host's shared id encoder rather than
   * by string concatenation.
   *
   * `undefined` for standalone usage without an owning form layout; a
   * component rendering on its own picks its own per-instance namespace.
   */
  idPrefix?: string;
  /**
   * Id the component must set on its focusable control (`id={controlId}`),
   * when supplied by the form layout that owns label rendering — see the
   * control id contract above. `undefined` for standalone usage without an
   * owning shell, and for composite field types, which have no single
   * control this id could target.
   */
  controlId?: string;
  /**
   * Whether the control should render as invalid for assistive technology
   * and error styling.
   *
   * The validation error *message* is not part of this contract: the owning
   * form layout renders it (see the error ownership note above) and points
   * the control at it through {@link describedById}, so a component must
   * never render the message itself — doing so would show it twice and
   * announce it twice.
   */
  invalid?: boolean;
  /**
   * Id(s) of the element(s) that describe this control (error message,
   * description, provenance hint), space-separated per the
   * `aria-describedby` attribute contract.
   *
   * Set by a form layout that owns description/error rendering outside the
   * control, for single-control field types only — composite field types
   * keep their description attached to the surrounding group instead, since
   * no single control could carry it correctly. Cooperating field
   * components spread this directly onto their control's
   * `aria-describedby`.
   */
  describedById?: string;
}
