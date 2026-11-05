# H7Lobby

Cloudflare Worker + one SQLite-backed Durable Object (`Lobby`): the online game list for Heroes VII multiplayer.
The game client is the online support in H7ModEngine (`N:\Projects\H7ModEngine`, design in its
`docs/ONLINE.md`); the API in `README.md` is the contract with it: change both together.

- `npm test` (Vitest in workerd via `@cloudflare/vitest-plugin`; the old `vitest-pool-workers` is deprecated),
  `npm run typecheck`. Both must pass; CI also runs `wrangler types --check` and a dry-run bundle.
- After editing `wrangler.jsonc`, run `npm run types` (regenerates `worker-configuration.d.ts`, committed).
- npm 11 blocks install scripts: `workerd` and `esbuild` are approved in `package.json` `allowScripts`; a version
  bump needs `npm install-scripts approve workerd esbuild` again.
- Everything a host sends is untrusted: validate in `src/validate.ts`, never trust `X-Client-IP` from the
  client (the entry Worker overwrites it with `CF-Connecting-IP`).
- Deployed by Cloudflare Workers Builds from `main` (dashboard "Import a repository"); no secrets in the repo.
- Free plan: keep requests per game low (heartbeat 15 s). Don't add per-request storage scans.
- Host verification (`src/verify.ts`, protocol in README): `POST /v1/games` is handled in the entry Worker, which
  waits on the TCP challenge; socket waits never go in the Durable Object (billed by wall-clock). The DO's
  `/internal/*` routes trust `X-Client-IP`/`X-Host-IP` because the entry Worker never forwards paths outside `/v1/`.
  `VERIFY` is "on" in `wrangler.jsonc`, "off" in tests; the C++ responder in H7ModEngine pins the same test vector.
- The entry module (`src/index.ts`) may export only handlers and classes (constants live in `src/constants.ts`):
  workerd refuses to start otherwise, and vitest doesn't notice (`test/verify.test.ts` guards it).
- `ADMIN_TOKEN` is a secret set in Cloudflare, never in the repo; admin routes 404 without it.
