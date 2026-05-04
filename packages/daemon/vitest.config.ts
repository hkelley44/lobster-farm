import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests spawn real subprocesses (mock Claude scripts with sleep).
    // Default 5s is too tight on CI runners where process startup is slower.
    testTimeout: 20_000,
    // Cap concurrent fork workers to reduce peak dirty-write I/O. The macOS
    // resource coalition that contains the daemon enforces a 2 GiB / 24h
    // dirty-write budget; 14 workers (M4 Max default) push past it. 4 cuts
    // peak I/O ~70%. This is a partial mitigation only — no userspace wrapper
    // (setsid, nohup, sudo, launchctl asuser, sandbox-exec) breaks macOS
    // coalition inheritance, so agents still need `pnpm --filter <package>`
    // for safe single-package runs. See issues #28, #34, #35.
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
