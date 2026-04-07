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
- 🟡 **Should address** — Robustness gaps, performance concerns, maintainability issues. Blocks merge in automated review.
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
