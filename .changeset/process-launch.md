---
"@makaio/framework": major
"@makaio/runtime-node": major
"@makaio/subsystem-workflow-engine": major
"@makaio/extension-git-hooks": patch
"@makaio/adapter-codex-app-server": patch
---

`launch` runs a bounded command and reports what became of it. The whole barrel of `@makaio/subprocess` is public as `@makaio/framework/node/subprocess`, so `launch` and its option, status, refusal and result types are available to framework consumers.

**One launcher for bounded commands.** Host commands that used to start processes with their own `spawn` or `execFile` now go through `launch`: the `git` calls of the git subsystem and of `@makaio/extension-git-hooks`, and the `launchctl` and `security` calls of the macOS platform. Each call has a time limit and a limit on captured output, runs in a process group of its own, and is checked for descendants that outlive the command. `launchctl` and `security` calls are limited to 10 s, `git` calls to 30 s, and `git` now runs in its own process group. The error text of a converted host command no longer contains the command arguments.

**Removed from `@makaio/framework` (workflow engine):** `runShellStep` and its types. Shell steps are no longer run by the engine.

**Removed from `@makaio/runtime-node`:** the workspace setup command driver and `SetupProcessGroupObservation`. The Setup process-group fact that backs the `setup-process-group` conclusion of attempt cancellation now comes from the facts `launch` records about the group it owned. Setup conclusions keep their four codes and their summaries.

**Windows:** `launch` supports it. A stop goes through the tree kill (`taskkill /T`), and the proof that nothing is left comes from the tree evidence. No continuous integration job runs on Windows, so this support is not exercised by the project's own pipeline.

**Lint rule:** process starts outside `launch` are forbidden in shipped sources. The guard is a custom ESLint rule (`process-start/no-direct-process-start`) for `node:child_process`, `child_process`, `execa` and `node-pty`; it applies to `.ts` and `.tsx` sources and catches static imports and re-exports, dynamic `import()`, `require`/`createRequire`, and `Bun.spawn`/`Bun.spawnSync`/`Bun.$`. It is mounted in the framework config and in the workspace root config, plus a layer for the application sources. Its exemption list names a reason per file: long-lived children with streams (FACT-384), the follow-ups FACT-380 (keychain access in `@makaio/utils`), FACT-381 (CLI detection, Windows command shims) and FACT-382 (statusline handler), synchronous tmux calls, PTY bridges, detached launches, a test helper and a build script. Type-only imports and tests are not affected.

**Refusals and cancellation:** `launch` re-checks the abort signal after registering its listener, so an abort that happens while the command starts is reported as `cancelled` and stops the child. A missing working directory is refused as `spawn-error`; `command-not-found` means ENOENT with an existing working directory (Node reports both alike, so the directory is checked after the failure and the answer is not race-free). On Windows, `launch` matches environment names case-insensitively, so an `undefined` value removes an inherited entry of any letter case and an override replaces an inherited entry that differs only in case.

**Helpers:** `launchForOutput` runs a bounded command and returns its captured output or the failed result, and rethrows an abort on cancellation. Bounded commands default to a 200 ms kill grace and a 2 s exit observation. `LaunchRefusal` gains `unsupported-platform`, `invalid-stop-timing` and `invalid-output-limit`: `launch` refuses a stop timing option (`killGraceMs`, `exitObservationMs`, `quiescenceProofTimeoutMs`) that is not a whole number of milliseconds up to 2147483647, and a capture limit that is not an integer from 0 to the maximum string length, before anything is started. The `./testing` subpath (`@makaio/framework/node/subprocess/testing`) exports `recordingLaunch` for tests. The bounded commands of the application (`gh`, `git`, the container entrypoint clone, the keychain storage) use `launch` as well; the container clone is now limited to 15 minutes and keychain commands to 30 s.

`@makaio/adapter-codex-app-server` imports the subprocess helpers through `@makaio/framework/node/subprocess` in its published build; its behaviour is unchanged.
