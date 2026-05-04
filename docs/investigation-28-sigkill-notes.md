# Investigation Notes — Issue #28: pnpm -r test SIGKILL (exit 137)

_Investigation date: 2026-05-03. Investigator: Karim (Operator)._

## Conclusion

**The killer is macOS resource coalition disk write accounting, not Jetsam memory pressure.**

macOS enforces a 2 GiB / 24-hour dirty-write budget per resource coalition. The daemon's launchd service owns coalition `com.lobsterfarm.daemon` (ID 1153). Every process spawned from the daemon — including tmux sessions, claude agents, pnpm, and all vitest fork workers — inherits and contributes to this coalition's write budget. After a full day of daemon operation (~2 GiB accumulated), any agent that runs `pnpm install` + `pnpm -r test` pushes the coalition over the limit and one of the vitest workers gets SIGKILL'd.

## Evidence

**Diagnostic report:** `/Library/Logs/DiagnosticReports/node_2026-04-28-225125_Tiduss-Mac-Studio.diag`

```
Event:            disk writes
Action taken:     none
Writes:           2147.50 MB over 24016 seconds (89.42 KB/s average)
Writes limit:     2147.48 MB (= exactly 2 GiB)
Limit duration:   86400s (24 hours)
Resource Coalition: "com.lobsterfarm.daemon"(1153)
Killed process:   node [PID 5907]
Footprint:        96.66 MB -> 861.89 MB (+765 MB) at kill time
```

The same limit (2147.48 MB at 24.86 KB/s over 86400s) appears in a second diagnostic:
`/Library/Logs/DiagnosticReports/rsync_2026-04-28-161922_Tiduss-Mac-Studio.diag` — Google Updater's rsync hit the identical budget. This confirms the limit is a system-wide macOS policy applied to all coalitions equally.

**launchctl confirms prior kills:**
```
launchctl print gui/501/com.lobsterfarm.daemon
  runs = 16
  last terminating signal = Killed: 9
```

**System log from this session confirms coalition inheritance:**
```
runningboardd: resource coalition id: 1153, jetsam coalition id: 1154
```
Every vitest fork worker spawned during the investigation session appeared in coalition 1153 — the daemon's own coalition — confirming the inheritance chain.

## Process chain

```
launchd
  └── node [6511] (daemon, com.lobsterfarm.daemon coalition 1153)
        └── tmux new-session (re-parents to launchd PPID=1, but RETAINS coalition 1153)
              └── claude agent (inside tmux)
                    └── pnpm -r test
                          └── vitest run
                                ├── fork worker 1  ─┐
                                ├── fork worker 2   │ all in coalition 1153
                                ├── ...             │
                                └── fork worker 14 ─┘ (14 = M4 Max core count, vitest default)
```

On macOS, coalition membership is set at process creation and persists through re-parenting. tmux daemonizes (PPID becomes 1) but the coalition inherited from the daemon's spawn call is not changed. All descendants of that tmux server remain in coalition 1153.

## Why tests pass now (and in a fresh boot cycle)

Tested `pnpm -r test` from both the canonical source and a fresh worktree today — both complete cleanly in ~5.5 seconds. The daemon (PID 6511) is relatively new in this boot cycle; the coalition's write budget has not yet been spent down. The kill is a 24-hour accumulation problem, not a per-run memory spike.

## Memory profile

RAM was never the problem. System had 93% free memory (36 GB total, ~33 GB free) during testing. Jetsam memory limits on the daemon coalition are `unlimited`. The vitest fork workers do grow significantly (each worker can reach ~860 MB footprint while loading all daemon test modules) but this growth is tolerated by the kernel — it is the dirty write I/O that triggers the kill.

## Daemon process: was it affected?

The diagnostic report shows the SIGKILL landed on a vitest fork worker (node PID 5907), not directly on the daemon. However, launchctl shows `last terminating signal = Killed: 9` and `runs = 16`, indicating the daemon itself was killed at least once. The likeliest sequence: vitest worker is killed → pnpm exits non-zero → agent session fails → daemon's session manager handles the crash — but the kill may also propagate up the process tree in some scenarios (e.g., if the vitest process that is directly killed is an ancestor of the worker in that chain).

## Why the workaround (#29) works

`pnpm --filter @lobster-farm/daemon test` runs only the daemon package's vitest, skipping the parallel `pnpm -r` coordinator and the shared/cli packages. This reduces total dirty writes per run by roughly 3x (3 packages vs 1) and avoids the worst-case scenario of running all packages in parallel.

## Recommendations for the fix issue

See issue body for full recommendation. In brief:

1. **Move agent test runs out of the daemon's coalition.** Spawn `pnpm test` via `setsid` or a wrapper that breaks coalition inheritance before running tests. This is the surgical fix.
2. **Add `--pool-options.forks.maxForks=4` to vitest config** as a secondary guard. Reduces per-run dirty writes by reducing parallel fork overhead.
3. **Do not run `pnpm -r test` from agent sessions** as a standing policy (already documented in #29 workaround doc).
