import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // No outbound TCP probes in tests (and private addresses are allowed).
      miniflare: { bindings: { PROBE: "off" } },
    }),
  ],
});
