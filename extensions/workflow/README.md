# @makaio/extension-workflow

Workflow CLI extension for running Makaio workflow files from the command line.

The extension contributes `makaio workflow run` and can boot an embedded
headless Node runtime through the public `@makaio/runtime-node` API when no
already-running Makaio daemon provides a bus.

```bash
makaio workflow run ./workflow.ts
makaio workflow run ./workflow.ts --payload '{"branch":"main"}'
```
