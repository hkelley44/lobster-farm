# Investigation Notes — Issue #35: Coalition Isolation Fix Options

_Investigation date: 2026-05-03. Investigator: Karim (Operator)._

## Summary

Empirically tested all five candidate options from issue #35. **Option A (launchd bootstrap) works and is the recommended fix.** Option B (posix_spawn shim) is blocked by SIP. Options C, D, and E are not viable as standalone fixes.

---

## Environment

- macOS Darwin 25.2.0, Apple M4 Max, SIP enabled
- Daemon coalition: `com.lobsterfarm.daemon` (ID 1153)
- Current session runs in coalition 1153 (confirmed via `launchctl print pid/<pid>`)
- Coalition 1153 accumulated write budget at time of investigation: ~7.6 GiB total (daemon restarts reset the 24h window; `runs=16` means ~16 daemon restarts which is why we haven't been killed today)

---

## Option B — posix_spawn shim with coalition attribute

**Result: BLOCKED by SIP. Not viable.**

### What we found

`_posix_spawnattr_setcoalition_np` is exported from `/usr/lib/system/libsystem_kernel.dylib` with no public SDK header declaration. Signature inferred from disassembly:

```c
int posix_spawnattr_setcoalition_np(
    posix_spawnattr_t *attr,
    uint64_t coalition_id,
    int coalition_type,   // 0=resource, 1=jetsam; validated <= 1
    int role
);
```

The function requires a pre-existing valid coalition ID — passing `coalition_id=0` causes `posix_spawn` to return `EINVAL`. To get a new coalition ID, you must call `coalition_create(uint64_t *id, int flags)`, also exported from the same dylib.

**`coalition_create` fails with `EPERM` (errno=1) from all contexts:**
- Unprivileged user: `EPERM`
- Root (via `sudo`): `EPERM`
- Direct syscall (`SYS_coalition=458`): `EPERM`

The entitlement required is `com.apple.private.coalition-policy`, confirmed by inspecting `/usr/libexec/runningboardd` and `/sbin/launchd`. With SIP enabled, ad-hoc signing a binary with `com.apple.private.*` entitlements causes immediate SIGKILL (exit 137) by AMFI when the binary executes. Non-private entitlements work fine under ad-hoc signing. SIP cannot be disabled without rebooting into recovery mode — not acceptable as a deployment dependency.

**Conclusion:** Option B is not viable on a SIP-enabled production machine. The posix_spawn coalition attribute exists in the kernel ABI, but the coalition creation step that would precede it is gated behind a private entitlement that Apple does not grant to third-party applications.

---

## Option A — Dynamic launchd bootstrap per test run

**Result: WORKS. Coalition is fully isolated. Recommended.**

### What we found

A process launched via `launchctl bootstrap gui/501 <plist>` runs in its own new coalition named after the plist's `Label` key.

Test results:

```
# Test 1: /bin/sleep 60 via dynamic plist bootstrap
$ launchctl bootstrap gui/501 /tmp/com.lobsterfarm.test.1777859095.plist
$ launchctl print pid/<sleep_pid> | grep -A 5 'resource coalition'
    resource coalition = {
        ID = 44384
        type = resource
        state = active
        active count = 1
        name = com.lobsterfarm.test.1777859095
    }

# Test 2: node -e "..." via dynamic plist bootstrap (simulates pnpm test)
$ launchctl print pid/<node_pid> | grep -A 5 'resource coalition'
    resource coalition = {
        ID = 44386
        type = resource
        state = active
        active count = 1
        name = com.lobsterfarm.test.nodetest
    }

# Test 3: Children of a bootstrapped service inherit the service's coalition (not 1153)
$ launchctl print pid/<bash_parent> → coalition ID 44378
$ launchctl print pid/<sleep_child> → coalition ID 44378
# Both are in the service's own coalition, not the daemon's coalition 1153.
```

This is the mechanism launchd uses for all managed services. When the daemon bootstraps a new service, launchd creates a new coalition for it at `posix_spawn` time — exactly what `posix_spawnattr_setcoalition_np` does internally, but launchd has `com.apple.private.coalition-policy` and can do it.

### Implementation shape (for the fix issue)

A wrapper script (e.g. `scripts/run-tests-isolated.sh`) that:

1. Writes a one-shot plist with a unique label (e.g. `com.lobsterfarm.test.<timestamp>`) to a temp path
2. Calls `launchctl bootstrap gui/501 <plist>`
3. Monitors for completion (either via plist `ExitTimeout`, log file, or a sentinel file written by the test command)
4. Calls `launchctl bootout gui/501/<label>` to clean up
5. Returns the test exit code

This wrapper can be invoked from within an agent session without any risk to the daemon coalition, because the entire test run happens in a separate coalition.

**Operational notes:**
- `launchctl bootstrap` requires the gui/501 domain (user's launchd domain). Works from within agent sessions — no privilege escalation needed.
- Exit code propagation requires a small convention: either redirect stdout/stderr to temp files and use `StandardOutPath`/`StandardErrorPath` plist keys, or use a short-lived wrapper script that writes exit code to a sentinel file.
- The launchd service must be booted out after completion; leaked services accumulate but launchd will GC them on next boot. A cleanup trap handles the normal case.
- Race condition: if the agent session is killed mid-run, the ephemeral launchd service may be left running. The test command itself will finish normally (it's outside the agent coalition now), but the launchd service cleanup requires a separate `bootout` call. A cleanup manifest or a `launchctl list | grep com.lobsterfarm.test` sweep at session start handles this.

---

## Option C — XPC service runner

**Result: WOULD work for coalition isolation, but reduces to Option A in complexity. Not recommended as separate option.**

XPC services are launchd-managed services. They get their own coalition by virtue of being bootstrapped into launchd, identical to Option A. Tested indirectly: `com.apple.cfprefsd.xpc.daemon` and `com.apple.notifyd` both run in their own coalitions separate from any parent. The coalition isolation would be equivalent to Option A.

The added complexity of XPC (bundle structure, XPC protocol, service definition in `Info.plist`, handling XPC messages) provides no additional benefit over a plain launchd agent for this use case. Option A is the same mechanism with less code.

---

## Option D — sandbox-exec with custom profile

**Result: Does NOT isolate coalition. Dead end.**

Tested `sandbox-exec -f <custom_profile> /bin/sleep 20` with a permissive custom profile (`(version 1) (allow default) (deny mach-register ...)`). The spawned process remains in coalition 1153. This matches Ben's prior finding with default profiles in PR #34.

`sandbox-exec` is a security/MAC boundary; it has no effect on Mach resource coalition membership. The sandbox profile language has no concept of coalition assignment. Coalition is set at `posix_spawn` time by the parent process, not by any runtime policy.

---

## Option E — Mitigation-only

**Result: Already shipped in PR #34. Inadequate as a standalone solution.**

The `maxForks: 4` cap and `pnpm --filter` guidance in PR #34 reduce the per-run write volume and make kills rarer, but do not change the inheritance mechanism. With the daemon running long enough (approaching 2 GiB written), any multi-package test run can still trigger the kill.

Option E is acceptable only as a belt-and-suspenders companion to Option A, not as a standalone fix.

---

## Negative results (confirming prior art from PR #34)

All previously tested approaches confirmed dead:
- `setsid`, `setsid -f`: POSIX session, not Mach coalition. Stays in 1153.
- `nohup`: No effect on coalition.
- `sudo bash`: Root doesn't help; root still inherits parent coalition.
- `launchctl asuser 501 <cmd>`: Runs in the same user domain; coalition inherited from spawning process.
- `sandbox-exec` (any profile): Security boundary, not resource boundary.
- `posix_spawnattr_setcoalition_np` without `coalition_create`: EINVAL on coalition_id=0.
- `coalition_create` from userspace: EPERM, even as root.
- Ad-hoc signed binary with `com.apple.private.coalition-policy`: SIGKILL from AMFI.

---

## Recommendation

**Implement Option A as a `scripts/run-tests-isolated.sh` wrapper.**

Cost: ~50 lines of shell, one new script in the repo, one-line update to `coding-dna/SKILL.md`.

Benefit: Every test run from an agent session is fully isolated from the daemon's coalition budget. The SIGKILL mechanism becomes structurally impossible for test runs (writes go to the ephemeral service's coalition, which has a fresh 2 GiB budget at every run).

Option B is the cleaner kernel-level fix but is blocked by SIP in a way that is not fixable without either Apple's signing infrastructure or disabling SIP. Not viable.

Option A is the correct fix. File a follow-up issue with the `scripts/run-tests-isolated.sh` spec.

---

## Commands used for verification

```bash
# Check current coalition
python3 -c "
import ctypes, subprocess, os
lib = ctypes.CDLL('/usr/lib/system/libsystem_kernel.dylib', use_errno=True)
pid = os.getpid()
result = subprocess.run(['launchctl', 'print', f'pid/{pid}'], capture_output=True, text=True)
print(result.stdout)
"

# Dynamic launchd bootstrap test
LABEL="com.lobsterfarm.test.$(date +%s)"
PLIST="/tmp/${LABEL}.plist"
# ... write plist, bootstrap, check coalition, bootout

# Check write budget
python3 -c "
import ctypes
lib = ctypes.CDLL('/usr/lib/system/libsystem_kernel.dylib', use_errno=True)
# coalition_info_resource_usage(coalition_id=1153, buf, bufsize) -> byteswritten
"
```
