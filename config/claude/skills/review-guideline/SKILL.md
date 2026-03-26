---
name: review-guideline
description: >
  Code review standards and quality evaluation criteria. Auto-loads during
  PR reviews, code audits, and pre-merge quality gates. Defines review
  priority order, comment format, and quality bars.
---

# Review Guideline

_Fresh eyes. Clear standards. Every review improves the codebase._

---

## Review Priority Order

Evaluate in this order. Blocking issues at any level should be flagged before moving on.

### 1. Correctness
- Does it do what the spec says? Check every acceptance criterion.
- Logic errors, off-by-one, incorrect assumptions?
- Conditional branches handle all cases (including the else)?
- Async operations properly awaited? Race conditions?

### 2. Security
- Hardcoded secrets, API keys, tokens — in code OR test fixtures?
- SQL injection? (Parameterized queries everywhere?)
- XSS? (User input sanitized before rendering?)
- Auth/authorization on all protected endpoints?
- Sensitive data in logs or error messages?

### 3. Robustness
- What happens when the database is down?
- What happens when an external API returns unexpected data?
- What happens when the request body is malformed?
- All error paths handled with meaningful messages?
- Timeouts configured for external calls?

### 4. Performance
- N+1 queries? (Check eager loading)
- Missing indexes for new query patterns?
- Unbounded data fetching? (No pagination or limits?)
- Large objects held in memory unnecessarily?

### 5. Maintainability
- Can a new developer understand this without explanation?
- Names descriptive of purpose?
- Complex logic commented (explaining WHY)?
- READMEs updated for changed directories?
- Tests present? Testing behavior, not implementation?

---

## Comment Format

```
🔴 [BLOCKING] file:line
Description of the issue.
Why it's a problem.
Suggested fix.

🟡 [SUGGESTION] file:line
What could be better and why.

🟢 [PRAISE] file:line
What was done well.
```

---

## Standards

- Every review results in **Approved** or **Changes Requested**. Never ambiguous.
- Blocking issues include concrete fix suggestions — not vague directives.
- Don't review formatting or style — linters handle that. If these show up in PRs, fix the tooling.
- One round of feedback should be sufficient. If your comments are clear, the builder addresses everything in one pass.

## Anti-Patterns for Reviewers

- ❌ "I would have done it differently" without a concrete problem — personal preference is not a review comment
- ❌ Reviewing architecture when it was approved in the spec — review the implementation, not the plan
- ❌ Rubber-stamping without reading — if you approve, you vouch for this code in production
- ❌ Reviewing only the diff without context — read the linked issue first
- ❌ Requesting features not in the spec — that's scope creep, not a review comment

---

_This DNA evolves. When we discover review patterns that catch more bugs or reduce review cycles, we codify them here._
