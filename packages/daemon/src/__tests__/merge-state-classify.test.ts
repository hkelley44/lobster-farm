/**
 * Tests for classify_merge_failure() — the pure function that maps
 * {mergeable, mergeStateStatus, error_text} → MergeFailure enum.
 *
 * Covers the AutoReviewer reliability cluster (#254, #262, #258).
 * Every case the daemon can observe in the wild should have a test here.
 */

import { describe, expect, it } from "vitest";
import {
  type MergeFailure,
  type MergeState,
  classify_merge_failure,
  format_merge_failure,
} from "../review-utils.js";

describe("classify_merge_failure", () => {
  const make_state = (overrides: Partial<MergeState> = {}): MergeState => ({
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    ...overrides,
  });

  it("returns CONFLICT when mergeable is CONFLICTING (regardless of status)", () => {
    expect(
      classify_merge_failure(
        make_state({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
        "",
      ),
    ).toBe<MergeFailure>("CONFLICT");
  });

  it("returns CONFLICT even if the error text looks like policy lag", () => {
    // CONFLICTING takes precedence — a real conflict needs human resolution,
    // not a retry loop.
    expect(
      classify_merge_failure(
        make_state({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
        "base branch policy prohibits the merge",
      ),
    ).toBe<MergeFailure>("CONFLICT");
  });

  it("returns BEHIND when mergeStateStatus is BEHIND", () => {
    expect(
      classify_merge_failure(
        make_state({ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }),
        "",
      ),
    ).toBe<MergeFailure>("BEHIND");
  });

  it("returns POLICY_LAG when error text matches 'base branch policy prohibits the merge'", () => {
    // This is the #262 bug: GitHub's branch-protection evaluation hasn't
    // caught up but the PR is otherwise mergeable. Must retry with backoff.
    expect(
      classify_merge_failure(
        make_state({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
        "X Pull request is not mergeable: the base branch policy prohibits the merge.",
      ),
    ).toBe<MergeFailure>("POLICY_LAG");
  });

  it("returns POLICY_LAG case-insensitively for the error text match", () => {
    expect(
      classify_merge_failure(
        make_state({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
        "Base Branch Policy Prohibits The Merge",
      ),
    ).toBe<MergeFailure>("POLICY_LAG");
  });

  it("returns REQUIRED_CHECKS_PENDING for BLOCKED + MERGEABLE with no policy-lag text", () => {
    // This is the #254 bug: PR is BLOCKED because CI is still running. No
    // rebase is needed; waiting for CI is the correct recovery.
    expect(
      classify_merge_failure(
        make_state({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
        "Pull request is not mergeable",
      ),
    ).toBe<MergeFailure>("REQUIRED_CHECKS_PENDING");
  });

  it("returns UNKNOWN for CLEAN state with an unrecognized error", () => {
    expect(
      classify_merge_failure(
        make_state({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
        "network timeout",
      ),
    ).toBe<MergeFailure>("UNKNOWN");
  });

  it("returns UNKNOWN for entirely unknown state", () => {
    expect(classify_merge_failure(make_state(), "")).toBe<MergeFailure>("UNKNOWN");
  });

  it("prefers BEHIND over POLICY_LAG when both apply", () => {
    // BEHIND is actionable (rebase) while POLICY_LAG is a wait. If both are
    // reported, rebasing is the right recovery — after rebase the PR is no
    // longer behind and any remaining lag cleans up via the usual flow.
    expect(
      classify_merge_failure(
        make_state({ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }),
        "base branch policy prohibits the merge",
      ),
    ).toBe<MergeFailure>("BEHIND");
  });
});

describe("format_merge_failure", () => {
  it("returns the canonical user-facing message for CONFLICT", () => {
    expect(format_merge_failure("CONFLICT", "")).toMatch(/conflicts.*manual/i);
  });

  it("returns a waiting-style message for REQUIRED_CHECKS_PENDING", () => {
    expect(format_merge_failure("REQUIRED_CHECKS_PENDING", "")).toMatch(/pending|check|retry/i);
  });

  it("returns a convergence message for POLICY_LAG", () => {
    expect(format_merge_failure("POLICY_LAG", "")).toMatch(/evaluat|converg|retry/i);
  });

  it("returns a behind message for BEHIND", () => {
    expect(format_merge_failure("BEHIND", "")).toMatch(/behind|rebase|update/i);
  });

  it("falls back to the raw error text for UNKNOWN", () => {
    expect(format_merge_failure("UNKNOWN", "some obscure error")).toContain("some obscure error");
  });

  it("does NOT return 'Rebase conflicts' for REQUIRED_CHECKS_PENDING", () => {
    // Regression test for #254 — the old code reported rebase conflicts for
    // a PR whose only problem was pending CI.
    expect(format_merge_failure("REQUIRED_CHECKS_PENDING", "")).not.toMatch(/conflict/i);
  });
});
