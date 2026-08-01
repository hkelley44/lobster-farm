import { describe, expect, it } from "vitest";
import { UNLOADED_JOB, classify_daemon_health, parse_launchd_print } from "../lib/daemon-health.js";

// ── parse_launchd_print ──
//
// Fixtures mirror real `launchctl print gui/<uid>/com.lobsterfarm.daemon`
// output — tab-indented `key = value` lines, with nested blocks that repeat
// `state = active` at deeper indentation.

const HEALTHY_PRINT = `gui/501/com.lobsterfarm.daemon = {
	active count = 1
	path = /Users/tidus/Library/LaunchAgents/com.lobsterfarm.daemon.plist
	state = running

	endpoints = {
		"com.lobsterfarm.daemon" = {
			state = active
		}
	}

	runs = 3
	pid = 79644
	last exit code = 0
}`;

// The #97 crash loop: state = spawn scheduled, nonzero last exit, huge runs,
// and no pid line (nothing is running).
const CRASH_LOOP_PRINT = `gui/501/com.lobsterfarm.daemon = {
	active count = 0
	state = spawn scheduled

	runs = 14882
	last exit code = 1
}`;

describe("parse_launchd_print", () => {
  it("parses state, pid, runs, and last exit code from a running job", () => {
    const result = parse_launchd_print(HEALTHY_PRINT);
    expect(result).toEqual({
      loaded: true,
      state: "running",
      pid: 79644,
      runs: 3,
      last_exit_code: 0,
    });
  });

  it("takes the top-level state, not a nested endpoint's state", () => {
    // The nested block says `state = active`; we must report "running".
    expect(parse_launchd_print(HEALTHY_PRINT).state).toBe("running");
  });

  it("parses a crash-looping job (no pid, nonzero exit, high runs)", () => {
    const result = parse_launchd_print(CRASH_LOOP_PRINT);
    expect(result.state).toBe("spawn scheduled");
    expect(result.pid).toBeNull();
    expect(result.runs).toBe(14882);
    expect(result.last_exit_code).toBe(1);
  });

  it("leaves last_exit_code null when launchd reports '(never exited)'", () => {
    const output = `gui/501/x = {
	state = running
	runs = 1
	pid = 42
	last exit code = (never exited)
}`;
    expect(parse_launchd_print(output).last_exit_code).toBeNull();
  });
});

// ── classify_daemon_health ──

describe("classify_daemon_health", () => {
  const running_job = parse_launchd_print(HEALTHY_PRINT); // pid 79644
  const crash_job = parse_launchd_print(CRASH_LOOP_PRINT);

  it("reports healthy when launchd runs the same PID the PID file names", () => {
    const report = classify_daemon_health(79644, true, running_job);
    expect(report.health).toBe("healthy");
    expect(report.warn).toBe(false);
  });

  it("flags a crash loop loudly (the #97 silent failure)", () => {
    const report = classify_daemon_health(null, false, crash_job);
    expect(report.health).toBe("crash_looping");
    expect(report.warn).toBe(true);
    expect(report.summary).toContain("CRASH-LOOPING");
    expect(report.summary).toContain("14882");
  });

  it("flags split-brain when the live PID file disagrees with launchd's PID", () => {
    // launchd runs 79644; PID file points at a *different* live process (orphan).
    const report = classify_daemon_health(12345, true, running_job);
    expect(report.health).toBe("split_brain");
    expect(report.warn).toBe(true);
  });

  it("flags split-brain when a live PID file exists but launchd is unloaded", () => {
    const report = classify_daemon_health(99999, true, UNLOADED_JOB);
    expect(report.health).toBe("split_brain");
    expect(report.warn).toBe(true);
    expect(report.summary).toContain("unsupervised");
  });

  it("reports not_managed when launchd is unloaded and no live PID file", () => {
    const report = classify_daemon_health(null, false, UNLOADED_JOB);
    expect(report.health).toBe("not_managed");
    expect(report.warn).toBe(false);
  });

  it("reports stopped when launchd manages the job but nothing runs cleanly", () => {
    const stopped_job = parse_launchd_print(`gui/501/x = {
	state = waiting
	runs = 5
	last exit code = 0
}`);
    const report = classify_daemon_health(null, false, stopped_job);
    expect(report.health).toBe("stopped");
    expect(report.warn).toBe(true);
  });
});
