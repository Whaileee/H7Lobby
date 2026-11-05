import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // No TCP challenge in tests (src/verify.ts is tested on its own and end to end with test/responder.mjs).
      miniflare: { bindings: { VERIFY: "off", ADMIN_TOKEN: "test-admin-token" } },
    }),
  ],
});
