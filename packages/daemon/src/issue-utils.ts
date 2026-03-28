/**
 * Shared utilities for GitHub issue extraction and lifecycle management.
 *
 * Consolidates duplicated logic from pr-cron.ts and webhook-handler.ts
 * into a single module. Used by both the cron path and the webhook path
 * to parse linked issues from PR bodies/titles and close them after merge.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ── Repo URL parsing ──

/**
 * Extract GitHub owner/repo ("name with owner") from a repo URL.
 * Handles both SSH (git@github.com:owner/repo.git) and
 * HTTPS (https://github.com/owner/repo.git) formats.
 * Returns undefined if the URL doesn't match either pattern.
 */
export function nwo_from_url(url: string): string | undefined {
  // SSH: git@github.com:owner/repo.git  or  HTTPS: https://github.com/owner/repo.git
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1];
}

// ── Issue extraction ──

/**
 * Extract linked issue numbers from PR body and title.
 *
 * Body patterns: "Closes #N", "Fixes #N", "Resolves #N" (case-insensitive, all occurrences).
 * Title pattern: "#N" (first match only — PR titles like "feat: add foo (#42)").
 */
export function extract_linked_issues(body: string | null, title: string | null): number[] {
  const issues = new Set<number>();

  // Parse "Closes #N", "Fixes #N", "Resolves #N" from body (all occurrences)
  if (body) {
    for (const match of body.matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi)) {
      issues.add(parseInt(match[1]!, 10));
    }
  }

  // Parse "#N" from PR title (first match)
  if (title) {
    const title_match = title.match(/#(\d+)/);
    if (title_match) {
      issues.add(parseInt(title_match[1]!, 10));
    }
  }

  return [...issues];
}

/**
 * Extract a single linked issue number from a PR body.
 * Returns the first "Closes/Fixes/Resolves #N" match, or null.
 *
 * Simpler variant used by the webhook handler where only the body is available
 * at the point of extracting issue context for the reviewer prompt.
 */
export function extract_first_linked_issue(body: string | null): number | null {
  if (!body) return null;
  const match = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return match ? parseInt(match[1]!, 10) : null;
}

// ── Issue context fetching ──

/**
 * Fetch issue title + body via gh CLI for reviewer context.
 * Returns empty string on error (fail-open).
 */
export async function fetch_issue_context(
  repo_path: string,
  issue_number: number,
  gh_token?: string,
): Promise<string> {
  try {
    const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;
    const { stdout } = await exec("gh", [
      "issue", "view", String(issue_number),
      "--json", "title,body,number",
      "--jq", `"## Issue #" + (.number | tostring) + ": " + .title + "\\n\\n" + .body`,
    ], {
      cwd: repo_path,
      timeout: 15_000,
      env,
    });
    const result = stdout.trim();

    // Truncate very long issue bodies to avoid blowing up reviewer context
    if (result.length > 2000) {
      return result.slice(0, 2000) + "\n\n[...truncated]";
    }
    return result;
  } catch (err) {
    console.log(
      `[issue-utils] Could not fetch issue #${String(issue_number)}: ${String(err)}`,
    );
    return "";
  }
}

// ── Issue closing ──

export interface CloseIssueResult {
  issue_number: number;
  success: boolean;
  error?: string;
}

/**
 * Close linked issues after a PR merge.
 *
 * For each issue:
 * 1. Adds a comment attributing the closure to the PR
 * 2. Closes the issue with state_reason: "completed"
 *
 * Uses the GitHub REST API with the installation token so the closure
 * is attributed to the GitHub App (lf-review[bot]), not a human account.
 *
 * Failures are logged but never thrown — a failed issue close must not
 * break the merge flow.
 */
export async function close_linked_issues(
  repo_full_name: string,
  pr_number: number,
  issue_numbers: number[],
  gh_token: string,
): Promise<CloseIssueResult[]> {
  if (issue_numbers.length === 0) return [];

  const results: CloseIssueResult[] = [];

  for (const issue_number of issue_numbers) {
    try {
      // 1. Add a comment attributing the closure to the PR
      const comment_res = await fetch(
        `https://api.github.com/repos/${repo_full_name}/issues/${String(issue_number)}/comments`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${gh_token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            body: `Closed by #${String(pr_number)}.`,
          }),
        },
      );

      if (!comment_res.ok) {
        const body = await comment_res.text();
        console.warn(
          `[issue-utils] Failed to comment on issue #${String(issue_number)}: ${String(comment_res.status)} ${body}`,
        );
        // Continue to close even if commenting fails
      }

      // 2. Close the issue
      const close_res = await fetch(
        `https://api.github.com/repos/${repo_full_name}/issues/${String(issue_number)}`,
        {
          method: "PATCH",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${gh_token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            state: "closed",
            state_reason: "completed",
          }),
        },
      );

      if (!close_res.ok) {
        const body = await close_res.text();
        const msg = `${String(close_res.status)} ${body}`;
        console.warn(`[issue-utils] Failed to close issue #${String(issue_number)}: ${msg}`);
        results.push({ issue_number, success: false, error: msg });
        continue;
      }

      console.log(`[issue-utils] Closed issue #${String(issue_number)} (via PR #${String(pr_number)})`);
      results.push({ issue_number, success: true });
    } catch (err) {
      const msg = String(err);
      console.warn(`[issue-utils] Error closing issue #${String(issue_number)}: ${msg}`);
      results.push({ issue_number, success: false, error: msg });
    }
  }

  return results;
}
