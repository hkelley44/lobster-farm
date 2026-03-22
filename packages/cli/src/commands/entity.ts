import { Command } from "commander";
import * as p from "@clack/prompts";
import { mkdir } from "node:fs/promises";
import {
  type PathConfig,
  entity_dir,
  entity_daily_dir,
  entity_context_dir,
  entity_files_dir,
  entity_config_path,
  entity_memory_path,
  write_yaml,
} from "@lobster-farm/shared";

export const entity_command = new Command("entity")
  .description("Manage LobsterFarm entities");

entity_command
  .command("create")
  .description("Create a new entity (project)")
  .option("--prefix <dir>", "Use a custom prefix directory instead of ~/")
  .action(async (options: { prefix?: string }) => {
    const prefix = options.prefix;
    const path_overrides: Partial<PathConfig> | undefined = prefix
      ? {
          lobsterfarm_dir: `${prefix}/.lobsterfarm`,
          claude_dir: `${prefix}/.claude`,
          projects_dir: `${prefix}/projects`,
        }
      : undefined;

    p.intro("Create a new LobsterFarm entity");

    // Entity ID
    const id_result = await p.text({
      message: "Entity ID (lowercase, hyphens only)",
      placeholder: "my-project",
      validate: (value) => {
        if (!value) return "Required";
        if (!/^[a-z0-9-]+$/.test(value)) return "Must be lowercase alphanumeric with hyphens";
        return undefined;
      },
    });
    if (p.isCancel(id_result)) { p.cancel("Cancelled"); process.exit(0); }
    const entity_id = id_result;

    // Name
    const name_result = await p.text({
      message: "Display name",
      placeholder: "My Project",
    });
    if (p.isCancel(name_result)) { p.cancel("Cancelled"); process.exit(0); }
    const entity_name = name_result;

    // Description
    const desc_result = await p.text({
      message: "Description (optional)",
      placeholder: "A brief description of this project",
      defaultValue: "",
    });
    if (p.isCancel(desc_result)) { p.cancel("Cancelled"); process.exit(0); }
    const description = desc_result;

    // Repo URL
    const repo_result = await p.text({
      message: "Git repo URL",
      placeholder: "git@github.com:org/repo.git",
    });
    if (p.isCancel(repo_result)) { p.cancel("Cancelled"); process.exit(0); }
    const repo_url = repo_result;

    // Repo local path
    const default_path = `~/projects/${entity_id}/${entity_id}`;
    const path_result = await p.text({
      message: "Local repo path",
      placeholder: default_path,
      defaultValue: default_path,
    });
    if (p.isCancel(path_result)) { p.cancel("Cancelled"); process.exit(0); }
    const repo_path = path_result;

    // GitHub account
    const github_org_result = await p.text({
      message: "GitHub org/username for this entity (optional)",
      placeholder: "my-org",
      defaultValue: "",
    });
    if (p.isCancel(github_org_result)) { p.cancel("Cancelled"); process.exit(0); }

    // Discord channels (optional)
    const setup_discord = await p.confirm({
      message: "Configure Discord channels for this entity?",
      initialValue: false,
    });
    if (p.isCancel(setup_discord)) { p.cancel("Cancelled"); process.exit(0); }

    interface DiscordChannel {
      type: string;
      id: string;
      purpose?: string;
    }
    const channels: DiscordChannel[] = [];

    if (setup_discord) {
      const channel_types = [
        { type: "general", purpose: "Entity-level discussion" },
        { type: "work_room", purpose: "Feature workspace 1" },
        { type: "work_room", purpose: "Feature workspace 2" },
        { type: "work_room", purpose: "Feature workspace 3" },
        { type: "work_log", purpose: "Agent activity feed" },
        { type: "alerts", purpose: "Approvals, blockers, questions" },
      ];

      for (const ch of channel_types) {
        const ch_id = await p.text({
          message: `Discord channel ID for ${ch.purpose} (${ch.type})`,
          placeholder: "Discord channel ID",
        });
        if (p.isCancel(ch_id)) { p.cancel("Cancelled"); process.exit(0); }
        if (ch_id) {
          channels.push({ type: ch.type, id: ch_id, purpose: ch.purpose });
        }
      }
    }

    // Build entity config
    const entity_config = {
      entity: {
        id: entity_id,
        name: entity_name,
        description: description || "",
        status: "active",
        repo: {
          url: repo_url,
          path: repo_path,
          structure: "monorepo",
        },
        accounts: {
          ...(github_org_result ? { github: { org: github_org_result } } : {}),
        },
        channels,
        agent_mode: "hybrid",
        models: {},
        budget: { monthly_warning_pct: 80, monthly_limit: null },
        memory: {
          path: entity_dir(path_overrides, entity_id),
          auto_extract: true,
        },
        active_sops: [
          "feature-lifecycle",
          "pr-review-merge",
          "secrets-management",
          "readme-maintenance",
        ],
        secrets: {
          vault: "1password",
          vault_name: `entity-${entity_id}`,
        },
      },
    };

    // Create directory structure
    const spin = p.spinner();
    spin.start("Creating entity directories...");

    const dirs = [
      entity_dir(path_overrides, entity_id),
      entity_daily_dir(path_overrides, entity_id),
      entity_context_dir(path_overrides, entity_id),
      entity_files_dir(path_overrides, entity_id),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
    spin.stop(`Created ${String(dirs.length)} directories`);

    // Write config
    spin.start("Writing entity config...");
    const config_path = entity_config_path(path_overrides, entity_id);
    await write_yaml(config_path, entity_config);
    spin.stop(`Config: ${config_path}`);

    // Create empty MEMORY.md
    const mem_path = entity_memory_path(path_overrides, entity_id);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      mem_path,
      `# ${entity_name} — Memory\n\n_Curated project knowledge. Updated by agents, reviewed periodically._\n`,
      "utf-8",
    );

    // Summary
    p.note(
      [
        `ID:          ${entity_id}`,
        `Name:        ${entity_name}`,
        `Config:      ${config_path}`,
        `Memory:      ${mem_path}`,
        `Repo:        ${repo_url}`,
        `Local path:  ${repo_path}`,
        channels.length > 0 ? `Discord:     ${String(channels.length)} channels configured` : "Discord:     not configured",
      ].join("\n"),
      "Entity Created",
    );

    p.outro(`Entity "${entity_id}" is ready. The daemon will pick it up on next restart (or reload).`);
  });
