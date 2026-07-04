import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";
import { defineConfig } from "tsup";

export default defineConfig({
  // The shim is a standalone MCP server spawned by the Claude CLI as its own
  // process (via --mcp-config), so it needs its own entry/bundle.
  entry: ["src/index.ts", "src/instrument.ts", "src/shim/discord-shim.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  // Upload source maps to Sentry when auth token is present (CI/CD builds).
  // Local dev builds skip this — no credentials needed for `pnpm build`.
  esbuildPlugins: process.env.SENTRY_AUTH_TOKEN
    ? [
        sentryEsbuildPlugin({
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        }),
      ]
    : [],
});
