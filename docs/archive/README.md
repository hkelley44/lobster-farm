# Archive

Historical / aspirational docs. **Not current. Do not treat as specification.**

Current architecture lives in `docs/architecture/`.

## Contents

- `lobsterfarm-architecture-v0.3.md` — v0.3 system architecture spec (Dec 2025). Described SOPs, feature state machines, daemon-managed work-room assignment, `!lf` command surface, label-based routing. Most of the orchestration layer it describes was never built — the shipped system uses a simpler subagent model (Gary spawns Bob via the Agent tool) and webhook-triggered reviewers.

- `guide/` — `index.html` + `lobsterfarm-guide.pdf`. User-facing guide rendered from the v0.3 spec. Describes the same aspirational workflow. Kept for reference; superseded by `docs/architecture/`.

## Why it's here, not deleted

Agents were confabulating the described workflows into live behavior (e.g. "the daemon auto-claims issues based on labels", "post in the work-room and the daemon routes it to Bob"). Moving to `archive/` stops grep-based discovery from treating these as authoritative while preserving the design history.
