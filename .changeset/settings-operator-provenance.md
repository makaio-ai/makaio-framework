---
'@makaio/contracts': minor
'@makaio/kernel': minor
'@makaio/services-core': minor
'@makaio/runtime-node': minor
---

Expose operator config provenance on the extension config schema response so the UI can render operator-owned fields as read-only.

**`@makaio/services-core` — schema extension**

`ExtensionGetConfigSchemaResponseSchema` gains an optional `operatorConfig` field:

```
operatorConfig?: {
  source: string;                   // Opaque label for the operator configuration source
  keys: string[];                   // The operator-owned config keys
  values?: Record<string, unknown>; // Effective values for those keys, when resolvable
}
```

The owned key set and the effective values are two separate facts, so they are
two separate fields. Which keys the operator owns follows from the operator
entry alone and is therefore always reported; which values the extension ends
up receiving is only knowable once its configuration resolves, which can fail
(for example when a schema has a required field with no default and the stored
layer holds something invalid). Collapsing both into one value map made an
operator-owned field editable whenever resolution failed, and an edit to such a
field is silently shadowed by the operator layer at merge time — exactly the
harm this provenance exists to prevent. Locking is therefore driven by `keys`;
`values` is a display convenience.

`values` carries the *effective* values — the merged configuration after the
extension's own config schema has parsed it, so transforms such as `.trim()`
are already applied. It is not a verbatim copy of the operator's input. `source`
is an opaque label and must not be assumed to be a file path; it may equally be
a secret-store path or any other origin the loader reports.

The field is absent when no operator configuration source supplies values for
the extension. Existing consumers that do not read it are unaffected.

**`@makaio/kernel` — coordinator accessor**

`ExtensionCoordinator.getResolvedConfig(name)` returns the schema-parsed
effective config for a loaded extension, resolved through the same path used at
activation but in `'observe'` mode, so it never throws. It is deliberately
state-neutral: a disabled, stopped, failed, or not-yet-started extension
resolves exactly like a running one, because resolution composes the
configuration layers and needs no live service or context. It returns
`undefined` when no extension is loaded under `name`, when the extension
declares no `configSchema`, or when the merged configuration is rejected and
the schema-default fallback parse fails as well.

**`@makaio/runtime-node` — handler wiring**

`registerRuntimeHandlers` accepts two new optional parameters:

```typescript
getExtensionOperatorConfig?: (extensionName: string) => ExtensionOperatorConfigEntry | undefined
getResolvedExtensionConfig?: (name: string) => unknown
```

The first supplies the set of operator-owned keys; the second supplies their
effective values. The `settings.extension.getConfigSchema` handler populates
`operatorConfig.keys` whenever the first yields a config entry, and adds
`operatorConfig.values` only when the second yields a record. Raw operator
values are never emitted as `values`, because that field carries no marker
distinguishing raw from resolved, so a consumer could not tell them apart.
Failure entries contribute nothing here — resolution errors are already
surfaced as extension activation diagnostics. When the first parameter is
omitted (no operator config active, or the isolated workflow runtime), the
field is absent from the response.

`boot.ts` wires both accessors from the operator config snapshot and the
extension coordinator that the boot sequence already holds, so every host
receives provenance without any additional configuration.

**`@makaio/contracts` — export additions**

`ExtensionOperatorConfigProvenance` describes the operator ownership metadata
(`source` plus the owned `keys`) handed to custom extension config components
through `ExtensionConfigComponentProps.operatorConfig`, so a component can
render locked fields itself.

`PluginWidgetRegistry` is now exported so consumers can augment it to register custom widget types (previously the augmentation point was unreachable).
