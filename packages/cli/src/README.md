# CLI Source

The `lf` command-line tool for managing the LobsterFarm daemon and entities. Built with Commander.js for command parsing and @clack/prompts for interactive wizards.

## Files

- `index.ts` -- Entrypoint. Registers all subcommands and invokes Commander's parser.

### commands/

- `init.ts` -- `lf init`. Interactive setup wizard that detects the machine environment, prompts for user/agent names and integrations, generates config files (config.yaml, CLAUDE.md, settings.json, agent files, skills), and creates the full directory structure.
- `start.ts` -- `lf start`. Resolves the daemon entry point, generates a macOS launchd plist, and loads it via `launchctl bootstrap`.
- `stop.ts` -- `lf stop`. Unloads the launchd service via `launchctl bootout`.
- `status.ts` -- `lf status`. Checks the PID file, verifies the process is alive, and queries the daemon's `/status` HTTP endpoint for runtime details.
- `entity.ts` -- `lf entity list` and `lf entity create`. Lists configured entities by scanning `~/.lobsterfarm/entities/`, or creates a new entity with interactive prompts (ID, name, repo, Discord channels) and scaffolds its directory structure and config.
- `update.ts` -- `lf update`. Pulls latest code, rebuilds, and relinks the CLI binary.

### commands/init/

- `detect.ts` -- Machine environment detection: hostname, hardware, platform, and availability checks for sudo, 1Password CLI, Claude Code, Bun, tmux, and GitHub CLI.
- `generate.ts` -- File generation for `lf init`. Copies and resolves templates for agent files, skills, CLAUDE.md, settings.json, user.md, tools.md, and creates the full `~/.lobsterfarm/` directory tree.
- `prompts.ts` -- Interactive prompt functions for `lf init`: user name, agent names (with defaults), Discord server ID, and GitHub username/org.

### lib/

- `launchd.ts` -- macOS launchd integration. Generates the wrapper script (`op inject` + `exec node`, never `op run -- node`, so node is never orphaned holding the port -- issue #97), plist XML, loads/unloads the service via `launchctl`, and reads job state (`get_launchd_job_state`).
- `daemon-health.ts` -- Reconciles the PID file against launchd's view (issue #97). `parse_launchd_print` extracts state/pid/runs/last-exit; `classify_daemon_health` labels the daemon `healthy` / `crash_looping` / `split_brain` / `stopped` / `not_managed` so `lf status` and `lf start` surface crash loops instead of reporting a false "running". Pure and unit-tested.
- `process.ts` -- Process utilities: PID file reading, process liveness check (signal 0), and shell command execution via the user's login shell.

## `.env.op` format (daemon secrets)

The daemon wrapper resolves `~/.lobsterfarm/.env.op` with `op inject` and parses the result itself, because it can no longer delegate to `op run --env-file` (that is what orphaned node on :7749 -- issue #97). The parser accepts standard dotenv, with one rule that `op run` did not impose:

**Multi-line secrets must be quoted.**

```sh
# Single-line values -- quotes optional, stripped if present
DISCORD_TOKEN=op://lobsterfarm/discord-daemon/token
SENTRY_DSN="op://command-center/sentry/dsn"

# Multi-line values (PEM keys) -- quotes REQUIRED
GITHUB_APP_PRIVATE_KEY="op://lobsterfarm/github-app/private-key"
```

`op inject` is a literal template substitution: it preserves the surrounding quotes and drops the multi-line secret between them, which makes the value unambiguous on sight.

Quoting alone is not enough to be *safe*, though, because a PEM body line can itself look like an assignment (`AbCdEf==` parses as key `AbCdEf`). So the wrapper does not decide "is this a new key?" from line shape. It first reads the key names `.env.op` **declares**, before injection -- the template holds `op://` references, never values, so reading it is safe and its keys are safe to name in warnings. `op inject` only substitutes values; it never adds or renames keys. Any line whose key was not declared is therefore a continuation line, however much it looks like an assignment.

If a multi-line value is left unquoted, the wrapper **drops it and warns** to `daemon.log` rather than exporting a truncated key. That is deliberate: a half PEM fails deep inside GitHub App auth at request time, while an absent one fails visibly at startup. Warnings name the key only, never the value.

**A missing closing quote aborts startup** (issue #101). The declared-key set also *bounds* the accumulation scan: while a quote is open, a line assigning a key `.env.op` declares ends the value there and is re-parsed as a fresh assignment. Without that bound the scan ran to EOF, so every secret declared after the malformed one was absorbed into its value and lost while the warning named only the first key -- the silent part, since nothing in the output said the others had vanished.

Now **every** offending key is named in a single startup, as `.env.op:<line>: unterminated quote for key '<KEY>'`, and then startup aborts: the wrapper exits non-zero instead of handing node a credential set it already knows is short (launchd surfaces that as a non-zero last-exit, which `lf status` reads via `daemon-health.ts`). To be explicit about what "aborts" costs, because it is easy to read the per-key reporting as a promise that the rest still works: **on abort nothing is exported at all.** node is never `exec`'d, so the well-formed secrets do not load either. One bad entry is *reported* as one bad entry; it still costs the whole startup until someone fixes the file. Reports carry key names and line numbers only -- never values.

The bound is tested *before* the closing-quote test, and that order is load-bearing (review round 5). Every single-line quoted declaration ends with a quote character, so testing for the close first consumed `DISCORD_TOKEN="..."` on the next line as the open value's *closing line*: the bound never fired, that secret was silently dropped, and the open key was exported with the next secret's bytes spliced into it -- exit 0, no output at all. Since the contract above tells operators to quote their secrets, that was the likelier of the two shapes. Both the quoted and the unquoted neighbour now abort identically.

The bound trades one unlikely failure for one likely one: a quoted value whose own body starts a line with a declared key name plus `=` terminates early. PEM base64 and JSON do not contain `DISCORD_TOKEN=`, and that case names both keys rather than failing silently. Since the bound is now tested first, this also applies to the value's *terminating* line.

**Known limitation (unhandled, tracked as issue #119).** The closing-quote test does not understand backslash-escaped quotes: a value whose *interior* line ends in `\"` is treated as closing there, exporting a truncated secret with exit 0. So the "missing closing quote aborts startup" guarantee above holds for the neighbour shapes described, not for a body line that ends in an escaped quote. `op inject` substitutes raw field bytes, so a 1Password field containing such a line reproduces it.

`export KEY=op://...` is accepted as well as bare `KEY=op://...`.

Also handled: CRLF-saved templates (a trailing `\r` is stripped rather than baked into every value); a template with no trailing newline (the last declaration is still read -- losing it would silently drop that secret *and* the one before it); a line that isn't a `KEY=value` declaration (warned, rather than quietly shrinking the key set); and a `.env.op` that declares no keys at all (injection is skipped with a warning instead of treating every line as garbage).

All of this is covered end-to-end in `__tests__/launchd.test.ts` -- real `zsh`, a stub `op`, and a stub node that dumps the environment it was exec'd with, including the identifier-shaped-PEM-body case.
