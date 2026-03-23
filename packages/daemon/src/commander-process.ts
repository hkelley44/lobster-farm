import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";

export interface CommanderHealth {
  state: "stopped" | "starting" | "running" | "crashed";
  pid: number | null;
  uptime_ms: number | null;
  restart_count: number;
  last_started_at: string | null;
}

const BACKOFF_SCHEDULE = [0, 5_000, 15_000, 60_000, 300_000];
const BACKOFF_RESET_MS = 10 * 60 * 1000; // 10 min stable → reset counter
const MAX_RESTARTS = 5;

/**
 * Manages a persistent Claude Code session connected to Discord via the
 * channel plugin. The daemon's only job: spawn, health check, restart on crash.
 */
export class CommanderProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: "stopped" | "starting" | "running" | "crashed" = "stopped";
  private restart_count = 0;
  private last_started_at: Date | null = null;
  private restart_timer: ReturnType<typeof setTimeout> | null = null;
  private backoff_reset_timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: LobsterFarmConfig) {
    super();
  }

  /** State directory for Pat's Discord channel plugin. */
  private state_dir(): string {
    return join(lobsterfarm_dir(this.config.paths), "channels", "pat");
  }

  /** Check if Pat's bot token is configured. */
  async has_token(): Promise<boolean> {
    try {
      const env_path = join(this.state_dir(), ".env");
      const content = await readFile(env_path, "utf-8");
      return content.includes("DISCORD_BOT_TOKEN=");
    } catch {
      return false;
    }
  }

  /** Start the persistent Commander session. */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return;
    }

    if (!(await this.has_token())) {
      console.log("[commander] No bot token at", join(this.state_dir(), ".env"));
      console.log("[commander] Pat will not start. Add the token and restart the daemon.");
      return;
    }

    this.state = "starting";
    const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
    const agent_name = this.config.agents.commander.name.toLowerCase();
    const working_dir = lobsterfarm_dir(this.config.paths);

    const claude_args = [
      "--channels", "plugin:discord@claude-plugins-official",
      "--agent", agent_name,
      "--model", "claude-opus-4-6",
      "--permission-mode", "bypassPermissions",
      "--add-dir", working_dir,
      "--add-dir", homedir(),
    ];

    console.log(`[commander] Starting ${agent_name} with Discord channel...`);

    // Claude Code's --channels requires an interactive session (TTY).
    // Wrap in `script` to provide a pseudo-TTY when spawned from the daemon.
    const proc = spawn("script", ["-q", "/dev/null", claude_bin, ...claude_args], {
      cwd: working_dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DISCORD_STATE_DIR: this.state_dir(),
      },
    });

    this.process = proc;
    this.last_started_at = new Date();

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        console.log(`[commander:stdout] ${text}`);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        console.log(`[commander:stderr] ${text}`);
      }
    });

    proc.on("spawn", () => {
      this.state = "running";
      this.emit("started", proc.pid);
      console.log(`[commander] ${agent_name} running (pid: ${String(proc.pid)})`);

      // Reset backoff after 10 min of stable running
      this.backoff_reset_timer = setTimeout(() => {
        if (this.state === "running") {
          this.restart_count = 0;
        }
      }, BACKOFF_RESET_MS);
    });

    proc.on("close", (code) => {
      this.process = null;
      if (this.backoff_reset_timer) {
        clearTimeout(this.backoff_reset_timer);
        this.backoff_reset_timer = null;
      }

      if (this.state === "stopped") {
        // Intentional shutdown
        console.log("[commander] Session ended (shutdown)");
        return;
      }

      this.state = "crashed";
      console.log(`[commander] Session exited with code ${String(code)}`);
      this.emit("crashed", code);
      this.schedule_restart();
    });

    proc.on("error", (err) => {
      this.process = null;
      this.state = "crashed";
      console.error(`[commander] Spawn failed: ${err.message}`);
      this.emit("error", err);
      this.schedule_restart();
    });
  }

  private schedule_restart(): void {
    this.restart_count++;

    if (this.restart_count > MAX_RESTARTS) {
      console.error(
        `[commander] Max restarts (${String(MAX_RESTARTS)}) exceeded. Giving up.`,
      );
      this.emit("gave_up", this.restart_count);
      return;
    }

    const delay =
      BACKOFF_SCHEDULE[
        Math.min(this.restart_count - 1, BACKOFF_SCHEDULE.length - 1)
      ]!;
    console.log(
      `[commander] Restart ${String(this.restart_count)}/${String(MAX_RESTARTS)} in ${String(delay / 1000)}s...`,
    );

    this.restart_timer = setTimeout(() => {
      void this.start();
    }, delay);
  }

  /** Gracefully stop the Commander session. */
  async stop(): Promise<void> {
    if (this.restart_timer) {
      clearTimeout(this.restart_timer);
      this.restart_timer = null;
    }
    if (this.backoff_reset_timer) {
      clearTimeout(this.backoff_reset_timer);
      this.backoff_reset_timer = null;
    }

    if (!this.process) {
      this.state = "stopped";
      return;
    }

    this.state = "stopped"; // Prevents close handler from restarting
    console.log("[commander] Stopping...");

    const proc = this.process;
    proc.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process === proc) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
  }

  /** Get health status. */
  health_check(): CommanderHealth {
    const now = Date.now();
    return {
      state: this.state,
      pid: this.process?.pid ?? null,
      uptime_ms:
        this.last_started_at && this.state === "running"
          ? now - this.last_started_at.getTime()
          : null,
      restart_count: this.restart_count,
      last_started_at: this.last_started_at?.toISOString() ?? null,
    };
  }
}
