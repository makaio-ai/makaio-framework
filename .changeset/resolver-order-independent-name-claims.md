---
'@makaio/services-package-manager': patch
---

Descriptor-name claims are now judged against the resolved target set after the
dependency queue drains instead of per install entry, so a batch's outcome no
longer depends on root submission order: a name handover between two roots in
one transaction succeeds in either order, while same-batch double claims stay
fatal with a deterministic, order-independent offender.

An optional dependency that installs successfully and only then fails a
descriptor assertion also joins that resolved set. The resolver has no
per-package undo, so such a package stays on disk; it is now judged with
everything else instead of vanishing from validation, which closes a path where
a resolution reported success while leaving two packages claiming one extension
name for the next boot to abort on.
