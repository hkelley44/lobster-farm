import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Client,
  GatewayIntentBits,
  type TextChannel,
  type Message,
} from "discord.js";
import type {
  LobsterFarmConfig,
  ChannelType,
  EntityConfig,
} from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager, CreateFeatureOptions } from "./features.js";
import { route_message, type RouteAction, type RoutedMessage } from "./router.js";
import type { TaskQueue } from "./queue.js";

const exec = promisify(execFile);

// ── Channel index entry ──

interface ChannelEntry {
  entity_id: string;
  channel_type: ChannelType;
  assigned_feature?: string | null;
}

// ── Discord Bot ──

export class DiscordBot extends EventEmitter {
  private client: Client;
  private channel_map = new Map<string, ChannelEntry>();
  private entity_channels = new Map<string, Map<ChannelType, string>>();
  private connected = false;

  constructor(
    private config: LobsterFarmConfig,
    private registry: EntityRegistry,
  ) {
    super();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  /** Connect to Discord. */
  async connect(token: string): Promise<void> {
    this.build_channel_map();

    this.client.on("ready", () => {
      const tag = this.client.user?.tag ?? "unknown";
      console.log(`[discord] Connected as ${tag}`);
      this.connected = true;
      this.emit("connected");
    });

    this.client.on("messageCreate", (message: Message) => {
      void this.handle_message(message);
    });

    await this.client.login(token);
  }

  /** Disconnect from Discord. */
  async disconnect(): Promise<void> {
    if (this.connected) {
      console.log("[discord] Disconnecting...");
      this.client.destroy();
      this.connected = false;
    }
  }

  /** Check if connected. */
  is_connected(): boolean {
    return this.connected;
  }

  /** Send a message to a specific channel ID. */
  async send(channel_id: string, content: string): Promise<void> {
    if (!this.connected) {
      console.log(`[discord:offline] Would send to ${channel_id}: ${content}`);
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      console.error(`[discord] Failed to send to ${channel_id}: ${String(err)}`);
    }
  }

  /** Send a message to an entity's channel by type. */
  async send_to_entity(
    entity_id: string,
    channel_type: ChannelType,
    content: string,
  ): Promise<void> {
    const entity_map = this.entity_channels.get(entity_id);
    if (!entity_map) {
      console.log(`[discord] No channel mapping for entity ${entity_id}`);
      return;
    }

    const channel_id = entity_map.get(channel_type);
    if (!channel_id) {
      console.log(`[discord] No ${channel_type} channel for entity ${entity_id}`);
      return;
    }

    await this.send(channel_id, content);
  }

  /** Rebuild the channel → entity/type index from entity configs. */
  build_channel_map(): void {
    this.channel_map.clear();
    this.entity_channels.clear();

    for (const entity_config of this.registry.get_all()) {
      const entity_id = entity_config.entity.id;
      const entity_map = new Map<ChannelType, string>();

      for (const channel of entity_config.entity.channels) {
        this.channel_map.set(channel.id, {
          entity_id,
          channel_type: channel.type,
          assigned_feature: channel.assigned_feature,
        });

        // For send_to_entity, store the first channel of each type
        if (!entity_map.has(channel.type)) {
          entity_map.set(channel.type, channel.id);
        }
      }

      this.entity_channels.set(entity_id, entity_map);
    }

    console.log(
      `[discord] Channel map built: ${String(this.channel_map.size)} channels across ${String(this.entity_channels.size)} entities`,
    );
  }

  /** Set references to feature manager and queue for command handling. */
  private _features: FeatureManager | null = null;
  private _queue: TaskQueue | null = null;

  set_managers(features: FeatureManager, queue: TaskQueue): void {
    this._features = features;
    this._queue = queue;
  }

  // ── Internal message handling ──

  private async handle_message(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Look up channel
    const entry = this.channel_map.get(message.channelId);
    if (!entry) return; // Message not in a mapped channel

    const routed: RoutedMessage = {
      entity_id: entry.entity_id,
      channel_type: entry.channel_type,
      content: message.content,
      author: message.author.tag,
      channel_id: message.channelId,
      assigned_feature: entry.assigned_feature,
    };

    const action = route_message(routed);

    try {
      await this.execute_action(action, routed, message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discord] Error handling message: ${msg}`);
      await this.reply(message, `Error: ${msg}`);
    }
  }

  private async execute_action(
    action: RouteAction,
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    switch (action.type) {
      case "command":
        await this.handle_command(action.name, action.args, routed, message);
        break;

      case "classify":
        await this.reply(
          message,
          `Classified as **${action.archetype}** task. ` +
            `Use \`!lf plan ${routed.entity_id} "${action.prompt}"\` to create a feature, ` +
            `or I can handle it directly (coming soon).`,
        );
        break;

      case "route_to_session":
        await this.reply(
          message,
          `Routing to feature **${action.feature_id}** session (interactive routing coming soon).`,
        );
        break;

      case "approval_response":
        await this.reply(
          message,
          `Received approval response. Use \`!lf approve <feature-id>\` to approve a specific feature.`,
        );
        break;

      case "ask_clarification":
        await this.reply(message, action.message);
        break;

      case "ignore":
        break;
    }
  }

  private async handle_command(
    name: string,
    args: string[],
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    switch (name) {
      case "help":
        await this.reply(
          message,
          "**LobsterFarm Commands:**\n" +
            "• `!lf plan <entity> <title>` — create a feature in plan phase\n" +
            "• `!lf approve <feature-id>` — approve current phase gate\n" +
            "• `!lf advance <feature-id>` — advance to next phase\n" +
            "• `!lf status` — daemon status\n" +
            "• `!lf features [entity]` — list features\n" +
            "• `!lf help` — this message",
        );
        break;

      case "status":
        await this.handle_status_command(message);
        break;

      case "plan":
        await this.handle_plan_command(args, routed, message);
        break;

      case "approve":
        await this.handle_approve_command(args, message);
        break;

      case "advance":
        await this.handle_advance_command(args, message);
        break;

      case "features":
        await this.handle_features_command(args, message);
        break;

      default:
        await this.reply(message, `Unknown command: \`${name}\`. Try \`!lf help\`.`);
    }
  }

  private async handle_status_command(message: Message): Promise<void> {
    const features = this._features;
    const queue = this._queue;

    const lines = ["**LobsterFarm Status**"];
    lines.push(`Entities: ${String(this.registry.count())} (${String(this.registry.get_active().length)} active)`);

    if (queue) {
      const stats = queue.get_stats();
      lines.push(`Queue: ${String(stats.active)} active, ${String(stats.pending)} pending`);
    }

    if (features) {
      const all = features.list_features();
      const by_phase = new Map<string, number>();
      for (const f of all) {
        by_phase.set(f.phase, (by_phase.get(f.phase) ?? 0) + 1);
      }
      if (all.length > 0) {
        const phase_summary = [...by_phase.entries()]
          .map(([p, c]) => `${p}: ${String(c)}`)
          .join(", ");
        lines.push(`Features: ${String(all.length)} total (${phase_summary})`);
      } else {
        lines.push("Features: none");
      }
    }

    lines.push(`Discord: connected`);
    await this.reply(message, lines.join("\n"));
  }

  private async handle_plan_command(
    args: string[],
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    // Parse: !lf plan <entity_id> <title>
    // If entity_id is omitted, use the channel's entity
    let entity_id: string;
    let title: string;

    if (args.length === 0) {
      await this.reply(message, "Usage: `!lf plan <entity> <title>` or `!lf plan <title>` (in an entity channel)");
      return;
    }

    // Check if first arg is a known entity
    const first_arg = args[0]!;
    if (this.registry.get(first_arg)) {
      entity_id = first_arg;
      title = args.slice(1).join(" ");
    } else {
      entity_id = routed.entity_id;
      title = args.join(" ");
    }

    if (!title) {
      await this.reply(message, "Please provide a title for the feature.");
      return;
    }

    // Generate a GitHub issue number (placeholder — in production, create the actual issue)
    const issue_number = Date.now() % 10000;

    try {
      const feature = features.create_feature({
        entity_id,
        title,
        github_issue: issue_number,
      });

      await this.reply(
        message,
        `Feature **${feature.id}** created: "${title}"\n` +
          `Phase: plan | Issue: #${String(issue_number)}\n` +
          `Approve with \`!lf approve ${feature.id}\`, then advance with \`!lf advance ${feature.id}\``,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to create feature: ${msg}`);
    }
  }

  private async handle_approve_command(args: string[], message: Message): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    const feature_id = args[0];
    if (!feature_id) {
      await this.reply(message, "Usage: `!lf approve <feature-id>`");
      return;
    }

    try {
      const feature = features.approve_phase(feature_id);
      await this.reply(
        message,
        `Approved phase **${feature.phase}** for ${feature_id}. ` +
          `Use \`!lf advance ${feature_id}\` to proceed.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to approve: ${msg}`);
    }
  }

  private async handle_advance_command(args: string[], message: Message): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    const feature_id = args[0];
    if (!feature_id) {
      await this.reply(message, "Usage: `!lf advance <feature-id>`");
      return;
    }

    try {
      const feature = await features.advance_feature(feature_id);
      await this.reply(
        message,
        `Feature **${feature_id}** advanced to **${feature.phase}** phase.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to advance: ${msg}`);
    }
  }

  private async handle_features_command(args: string[], message: Message): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    const entity_filter = args[0];
    const all = entity_filter
      ? features.get_features_by_entity(entity_filter)
      : features.list_features();

    if (all.length === 0) {
      await this.reply(message, "No features found.");
      return;
    }

    const lines = all.map((f) => {
      let status = `**${f.id}** — ${f.title} [${f.phase}]`;
      if (f.blocked) status += " (BLOCKED)";
      if (f.approved) status += " (approved)";
      if (f.sessionId) status += " (active session)";
      return status;
    });

    await this.reply(message, lines.join("\n"));
  }

  private async reply(message: Message, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch {
      // If reply fails, try sending to channel directly
      await this.send(message.channelId, content);
    }
  }
}

// ── Token resolution ──

/** Resolve the Discord bot token from env or 1Password. */
export async function resolve_bot_token(
  config: LobsterFarmConfig,
): Promise<string | null> {
  // 1. Environment variable
  const env_token = process.env["DISCORD_BOT_TOKEN"];
  if (env_token) {
    console.log("[discord] Using bot token from DISCORD_BOT_TOKEN env var");
    return env_token;
  }

  // 2. 1Password reference
  const op_ref = config.discord?.bot_token_ref;
  if (op_ref) {
    try {
      const { stdout } = await exec("op", ["read", op_ref]);
      const token = stdout.trim();
      if (token) {
        console.log("[discord] Using bot token from 1Password");
        return token;
      }
    } catch {
      console.log("[discord] Failed to read bot token from 1Password");
    }
  }

  return null;
}
