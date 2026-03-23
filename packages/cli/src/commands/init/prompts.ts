import * as p from "@clack/prompts";
import { DEFAULT_ARCHETYPES, type ArchetypeRole } from "@lobster-farm/shared";

/** Prompt for the user's name (required). */
export async function prompt_user_name(): Promise<string> {
  const name = await p.text({
    message: "What's your name?",
    placeholder: "e.g. Jax",
    validate: (value) => {
      if (!value.trim()) return "Name is required.";
      return undefined;
    },
  });
  if (p.isCancel(name)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return name.trim();
}

/** Prompt for agent names for the configurable archetypes. */
export async function prompt_agent_names(): Promise<
  Record<"planner" | "designer" | "builder" | "operator" | "commander", string>
> {
  p.note(
    "Your agents need names. Each role has a default — press Enter to keep it.",
    "Agent Names",
  );

  const roles: Array<"planner" | "designer" | "builder" | "operator" | "commander"> = [
    "planner",
    "designer",
    "builder",
    "operator",
    "commander",
  ];

  const result: Record<string, string> = {};

  for (const role of roles) {
    const defaults = DEFAULT_ARCHETYPES[role as ArchetypeRole];
    const name = await p.text({
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} agent name:`,
      placeholder: defaults.default_name,
      defaultValue: defaults.default_name,
    });
    if (p.isCancel(name)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    result[role] = name.trim() || defaults.default_name;
  }

  return result as Record<"planner" | "designer" | "builder" | "operator" | "commander", string>;
}

export interface DiscordSetup {
  server_id: string;
  daemon_bot_token: string;
  commander_bot_token?: string;
}

/** Prompt for Discord setup (optional). Returns server ID + bot tokens or undefined. */
export async function prompt_discord(existing_token?: boolean): Promise<DiscordSetup | undefined> {
  if (existing_token) {
    const overwrite = await p.confirm({
      message: "Discord bot tokens already configured. Update them?",
      initialValue: false,
    });
    if (p.isCancel(overwrite)) { p.cancel("Setup cancelled."); process.exit(0); }
    if (!overwrite) return undefined;
  } else {
    const wants_discord = await p.confirm({
      message: "Set up Discord integration?",
      initialValue: true,
    });
    if (p.isCancel(wants_discord)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    if (!wants_discord) return undefined;
  }

  p.note(
    "LobsterFarm uses two Discord bots:\n\n" +
      "1. Daemon bot — manages entity channels, scaffolding, webhooks.\n" +
      "   Needs: Manage Server, View Channels, Send Messages, Manage Webhooks.\n\n" +
      "2. Commander bot — your admin agent (Pat). Reads and replies in #command-center.\n" +
      "   Needs: View Channels, Send Messages, Read Message History, Attach Files, Add Reactions.\n\n" +
      "Create both at https://discord.com/developers/applications.\n" +
      "Enable Message Content Intent in the Bot tab for both.\n" +
      "Copy the server ID (right-click server → Copy Server ID).",
    "Discord Setup",
  );

  const server_id = await p.text({
    message: "Discord server ID:",
    placeholder: "e.g. 1234567890",
    validate: (value) => {
      if (!value.trim()) return "Server ID is required.";
      return undefined;
    },
  });
  if (p.isCancel(server_id)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const daemon_token = await p.password({
    message: "Daemon bot token (server management):",
    validate: (value) => {
      if (!value.trim()) return "Daemon bot token is required.";
      return undefined;
    },
  });
  if (p.isCancel(daemon_token)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const commander_token = await p.password({
    message: "Commander bot token (Pat — press Enter to skip):",
  });
  if (p.isCancel(commander_token)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    server_id: server_id.trim(),
    daemon_bot_token: daemon_token.trim(),
    commander_bot_token: commander_token?.trim() || undefined,
  };
}

/** Prompt for default GitHub account. */
export async function prompt_github(): Promise<{
  username: string;
}> {
  const username = await p.text({
    message: "Default GitHub account (used for all entities unless overridden):",
    placeholder: "e.g. spacelobsterfarm",
    defaultValue: "",
  });
  if (p.isCancel(username)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    username: (username ?? "").trim(),
  };
}

/** Prompt for entities directory (where entity repos live on disk). */
export async function prompt_projects_dir(): Promise<string> {
  const dir = await p.text({
    message: "Entities directory (where entity repos will live on disk):",
    placeholder: "~/entities",
    defaultValue: "~/entities",
  });
  if (p.isCancel(dir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return (dir ?? "~/entities").trim();
}
