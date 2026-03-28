import { defineConfig } from "tsup";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";

export default defineConfig({
  entry: ["src/index.ts", "src/instrument.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  // Upload source maps to Sentry when auth token is present (CI/CD builds).
  // Local dev builds skip this — no credentials needed for `pnpm build`.
  esbuildPlugins: process.env["SENTRY_AUTH_TOKEN"]
    ? [
        sentryEsbuildPlugin({
          org: process.env["SENTRY_ORG"],
          project: process.env["SENTRY_PROJECT"],
          authToken: process.env["SENTRY_AUTH_TOKEN"],
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        }),
      ]
    : [],
});
