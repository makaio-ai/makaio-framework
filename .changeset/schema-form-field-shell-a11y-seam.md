---
"@makaio/contracts": major
---

Make `FormFieldProps` a control-only contract: add optional `invalid`,
`describedById`, and `controlId`, and **remove `error`**. A host-owned form
layout/shell that owns label/error/description rendering outside the control
forwards invalid state, describedby ids, and the control's id to a cooperating
field component so `aria-invalid`/`aria-describedby`/`<label htmlFor>` attach
to the actual focusable control instead of a non-focusable wrapper. The error
*message* stays with the layout that renders it: a component that also received
the text would display and announce the same error twice. `controlId` replaces
the previously documented, unenforced `inputId` convention with a typed
contract: components must render `id={controlId ?? inputId ?? field.key}` on
their focusable control.

Breaking: field components that read `error` must derive their invalid styling
from `invalid` instead. Self-contained field renderers that own their own label
and error layout (rather than rendering a control for a shell) declare the
message prop themselves.

Also add `ExtensionFieldTypeRegistration` and `ExtensionFieldTypeEntry` to
`@makaio/contracts/extension`. An extension's `fieldTypes` contribution entry
can now be either a bare loader (unchanged, the common case) or a
`{ loader, composite? }` object, so extension-contributed field types that
render more than one focusable control can declare `composite: true` the
same way a host's field registry records it for its builtin field types.
