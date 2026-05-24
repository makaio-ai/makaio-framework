# Git Hooks Extension

Optional native Git hook integration for Makaio.

The extension installs POSIX wrapper scripts for `post-commit`, `post-checkout`,
`post-merge`, and `post-rewrite`. Wrappers preserve any existing hook, replay
stdin to both the original hook and the Makaio receiver, and fail open so Git
operations are not blocked by Makaio availability.

GitWatcher remains the fallback event source. It suppresses filesystem-derived
`commit` and branch `checkout` events only when this extension verifies that the
repository has healthy native hook coverage for that operation.
