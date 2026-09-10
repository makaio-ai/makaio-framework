# @makaio/extension-artifact-query

Portable read-only tools for selecting original content from schema-typed artifacts through an authorized host.

An integrating product supplies an `ArtifactReadHost` through `createArtifactQueryToolset(host)` or
`createArtifactQueryPackage(host)`. The host owns authorization, repository scope, effective Kind discovery,
and current-revision uniqueness. The package never derives scope from tool input or issues raw Artifact bus
requests. Its default package marker contributes no tools until a host is explicitly bound.

`artifacts_read` accepts a short purpose and one or more exact artifact references. It returns the compact kind view by default, selected declared fields when requested, or the complete original data for the reserved `full` view.
