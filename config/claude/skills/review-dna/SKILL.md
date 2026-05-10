---
name: review-dna
autoload_trigger: "PR review, code audit, pre-merge quality gate"
description: "Code review standards — priority order, frontend criteria, CI awareness"
---

# Review DNA

## Review Priority Order

1. **Correctness** — Does the code do what the spec says? Are there logic errors, off-by-ones, race conditions, null pointer risks?
2. **Security** — SQL injection, XSS, auth bypass, hardcoded secrets, insecure defaults, missing input validation?
3. **Robustness** — Error handling, edge cases, graceful degradation, timeout handling, retry logic?
4. **Performance** — N+1 queries, unnecessary re-renders, missing indexes, unbounded data fetching, memory leaks?
5. **Maintainability** — Unclear naming, missing types, duplicated logic, dead code, insufficient test coverage?

## Severity Levels

- 🔴 **Must fix** — Bugs, security issues, data loss risks, spec violations. Blocks merge.
- 🟡 **Should address** — Robustness gaps, performance concerns, maintainability issues. Reviewer requests changes when present.
- 🟢 **Praise** — Well-crafted code, clever solutions, good patterns. Always include at least one.

## Comment Format

Every blocking comment must include:
1. What's wrong (concrete, not vague)
2. Why it matters (impact, not just "best practice")
3. Suggested fix (code snippet or approach)

## Anti-Patterns (Never Do This)

- Personal preference without technical justification
- Reviewing the architecture instead of the implementation
- Rubber-stamping without reading the code
- Reviewing only the diff without understanding the issue/spec context
- Blocking on formatting or style (linters handle this)
- Requesting changes on more than one round — if your feedback is clear, one round is enough

---

## E2E pass — blocking vs. non-blocking

The final review iteration includes an end-to-end pass: playwright tests if the repo has them, plus access-tool exercise of the feature (browser automation, DB queries, API calls — whatever the feature touches). That pass produces findings that need to be classified before you decide the verdict.

**🔴 Blocking — flip verdict to Changes Requested:**

- Acceptance criterion in the spec is not met when exercised end-to-end (the unit tests passed but the user-facing behavior is broken)
- Crash, 500, unhandled promise rejection, or visible error state on a happy-path flow
- Data integrity break — wrong values written to the DB, persisted state diverges from what the UI shows, idempotent operation produces duplicates
- Auth / permission boundary breached (any action a user shouldn't be able to do, that they can)
- Security regression observable through the UI or API (token leaked into HTML, secret echoed in a response, missing CSRF on a state-changing endpoint)
- Performance cliff — happy path takes >10× the budget the spec or comparable existing flow sets. If neither applies, use absolute thresholds: >3s for a page load, >500ms for an API response under no load. When in doubt, note it as non-blocking and let the team set the budget.

**🟡 Non-blocking — note in the E2E comment, do not request changes:**

- Pre-existing issue you stumbled into that's outside the PR's scope (file an issue separately, link from your comment)
- Minor copy / spacing / styling nit that a linter or designer would catch
- Edge case the spec didn't ask for and a reasonable user wouldn't hit
- Flake that doesn't reproduce on a second run (note it, don't block)

**The decision rule:** if a reasonable user following the spec's described path would notice this, it's blocking. If they'd have to be looking for it, it's non-blocking.

Post the E2E result as a single PR comment that lists every finding under the right heading. The verdict (Approved or Changes Requested) is determined by whether the blocking list is empty.

---

## Spec-gap detection — bug vs. ambiguous spec

When something looks wrong, decide whether it's a bug (Ben implemented the wrong thing) or a spec gap (the spec didn't say what the right thing was). The two routes are different and routing it wrong wastes everyone's time.

**It's a bug — request changes from Ben:**

- The spec says X, the code does Y, and X is unambiguous
- An acceptance criterion is testable and the code fails it
- Pattern violation against an established DNA rule (security, robustness, naming, error handling)
- Regression in existing behavior the spec didn't touch

**It's a spec gap — pause and ping Tidus in #alerts:**

- The spec is silent on a decision the implementation had to make, and either choice is defensible
- Two acceptance criteria are in tension and the spec doesn't say which wins
- The spec assumes a precondition that isn't true in the code or environment
- Edge case the spec didn't anticipate, where guessing wrong has user-visible consequences
- Terminology mismatch — the spec uses one name, the codebase uses another, and you're not sure which is canonical

**Spec-gap escalation format (post in #alerts, ping Tidus):**

```
PR: <link>
Ambiguity: <one-sentence description>
Where Ben landed: <what the code does>
Other defensible reading: <what the spec might have meant instead>
Proposed clarification: <what you'd add to the spec to remove the ambiguity>
```

While the spec gap is being resolved, the cycle counter does **not** advance. Spec gaps aren't Ben's fault and shouldn't burn his budget. When Tidus replies with the clarification (and amends the GitHub issue), Ben implements against the updated spec and the loop continues from where it paused.
