/**
 * Shared repo → entity matching utility.
 *
 * Both `webhook-handler.ts` and `check-suite-handler.ts` need to map a GitHub
 * `repository.full_name` (e.g. "my-org/my-repo") to an entity. The matching
 * logic — substring check against each entity's repo URLs — is identical and
 * lives here to avoid duplication.
 */

import type { EntityConfig } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";

export interface RepoMatch {
  entity: EntityConfig;
  repo_path: string;
}

/**
 * Map a GitHub repo full_name (e.g. "my-org/my-repo") to an entity.
 * Checks each active entity's repo URLs for a substring match.
 *
 * Returns the matched entity config and the expanded repo path, or null if
 * no entity owns this repo.
 */
export function find_entity_for_repo(
  full_name: string,
  registry: EntityRegistry,
): RepoMatch | null {
  const lower = full_name.toLowerCase();

  for (const entity of registry.get_active()) {
    for (const repo of entity.entity.repos) {
      // Match against HTTPS URL: https://github.com/owner/repo.git
      // Match against SSH URL: git@github.com:owner/repo.git
      const url = repo.url.toLowerCase();
      if (url.includes(lower) || url.includes(lower.replace("/", ":"))) {
        return { entity, repo_path: expand_home(repo.path) };
      }
    }
  }

  return null;
}
