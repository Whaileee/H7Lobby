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
