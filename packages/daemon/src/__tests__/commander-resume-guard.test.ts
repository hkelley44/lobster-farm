import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommanderProcess } from "../commander-process.js";

class TestCommander extends CommanderProcess {
  transcripts = new Set<string>();
  protected override session_transcript_exists(session_id: string): Promise<boolean> {
    return Promise.resolve(this.transcripts.has(session_id));
  }
  resolve(): Promise<{ session_id: string; is_resume: boolean }> {
    return this.resolve_session();
  }
}

const PERSISTED = "f98dbc74-0000-4000-8000-000000000000";

describe("commander session resolution (#146)", () => {
  let root: string;
  let commander: TestCommander;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lf-commander-resume-"));
    await mkdir(join(root, "channels", "pat"), { recursive: true });
    commander = new TestCommander(
      LobsterFarmConfigSchema.parse({ user: { name: "Test" }, paths: { lobsterfarm_dir: root } }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function persist(session_id: string): Promise<void> {
    await writeFile(
      join(root, "channels", "pat", "session-state.json"),
      JSON.stringify({ session_id }),
    );
  }

  it("starts fresh when nothing is persisted", async () => {
    const { session_id, is_resume } = await commander.resolve();
    expect(is_resume).toBe(false);
    expect(session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("resumes a persisted session that has a transcript", async () => {
    await persist(PERSISTED);
    commander.transcripts.add(PERSISTED);
    expect(await commander.resolve()).toEqual({ session_id: PERSISTED, is_resume: true });
  });

  it("starts fresh instead of resuming a session that never took a turn", async () => {
    // The id is persisted at spawn; the transcript only appears on the first
    // turn. `--resume` on the former without the latter exits immediately.
    await persist(PERSISTED);
    const { session_id, is_resume } = await commander.resolve();
    expect(is_resume).toBe(false);
    expect(session_id).not.toBe(PERSISTED);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("has no transcript"));
  });
});
