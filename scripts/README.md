# scripts/

Repo-level shell utilities. One script per concern, executable, with a header comment block explaining the why.

## Contents

| Script | Purpose |
|---|---|
| `run-tests-isolated.sh` | Wrap any command in a one-shot launchd service so it runs in a fresh macOS resource coalition, breaking inheritance from the LobsterFarm daemon's coalition (id 1153). Use `scripts/run-tests-isolated.sh pnpm -r test` from agent sessions to avoid the SIGKILL kill path documented in #28. |

## Conventions

- All scripts use `#!/usr/bin/env bash` and `set -euo pipefail`.
- Each script begins with a comment block that explains **why** it exists, the mechanism it uses, and any non-obvious safety or security notes (env forwarding, cleanup, etc.).
- Scripts are committed with `+x` (`chmod +x`) so they can be invoked directly without `bash <script>`.
- New scripts should be macOS-friendly first (the agent host is Darwin) but degrade or no-op gracefully on Linux where possible.
