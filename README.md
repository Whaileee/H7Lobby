# H7Lobby

The online game list for **Might & Magic Heroes VII** multiplayer, now that Ubisoft's online services are shut
down. It runs on Cloudflare Workers (free plan) and is used by the online support built into
[H7ModEngine](https://github.com/Whaileee/H7ModEngine).

The public lobby: **https://h7-lobby.whaileee.workers.dev** (the engine's default, `[Online] LobbyUrl` in
`H7ModEngine.ini`). It deploys from `main` through Cloudflare Workers Builds.

The lobby is only a noticeboard. The host's own game is the server, and players connect to it directly, the same
way the game's LAN mode works. Game traffic never passes through Cloudflare:

```
 Host's game ──register / heartbeat (HTTPS)──▶  H7Lobby  ◀──list games (HTTPS)── Other players
     ▲                                                                                  │
     └────────────────── game traffic: UDP + TCP 27015, direct ─────────────────────────┘
```

## API

All bodies are JSON. Errors are `{"error": "message"}` with a 4xx status.

| Call | |
|---|---|
| `GET /` | `{service, api}` |
| `GET /v1/games?type=duel\|skirmish` | `{api, games: [...], heartbeat_s, ttl_s}`: open public games, newest first (private and started games are left out) |
| `GET /v1/games/:id` | One game, including private ones: the id works as an invite code |
| `POST /v1/games` | Register a game (below). `201 {id, token, ip, port, reachable, heartbeat_s, ttl_s}` |
| `POST /v1/games/:id/heartbeat` | `Authorization: Bearer <token>`. Optional body `{players, started}`. Send every `heartbeat_s` (15) seconds; a game without one for `ttl_s` (60) seconds is removed |
| `POST /v1/games/:id/probe` | `Authorization: Bearer <token>`. Repeat the reachability test (e.g. after the port was opened): `{reachable}` |
| `DELETE /v1/games/:id` | `Authorization: Bearer <token>`. `204` |

Registration body:

| Field | |
|---|---|
| `name` | 1–40 characters (the host's name) |
| `type` | `"skirmish"` or `"duel"` |
| `map` | Map file, up to 128 characters |
| `map_info` | Optional integer (the game's map info number) |
| `slots` | 2–8 |
| `players` | Optional, 1..slots (default 1) |
| `port` | Optional, 1024–65535 (default 27015) |
| `private` | Optional boolean: not listed, joinable by id |
| `game_version`, `engine_version` | Strings, up to 32 characters; clients hide games they can't join |
| `mods` | Optional `[{name, version}]`, up to 64 |
| `edition` | Optional `"base"` or `"modded"` (default: `"modded"` when `content` is non-empty) |
| `content` | Optional `[{name, version, files}]`, up to 128: the community content packs in the host's `CookedPC` folder; `version` is a content hash (up to 16 characters), so clients can name each pack that differs |
| `content_fingerprint` | Optional hash over all of `content` (up to 32 characters) |
| `settings` | Optional flat object of strings (up to 2048 characters)/numbers/booleans (turn type, random map string, ...), up to 32 keys |
| `ipv4` | Optional; only used when the host's request reached Cloudflare over IPv6 (the game listens on IPv4). The host's mod gets it from the router through UPnP |

The host's address is the IP its request came from, as Cloudflare saw it (private addresses are refused); hosts
can't register someone else's address. `reachable` is `null`: the host's game listens on UDP 27015 only, which a
Worker can't test (the TCP probe in `src/lobby.ts` stays available behind `PROBE = "on"`). Hosts open the port
with UPnP or by hand.

Limits: 10 registrations per minute and 3 games per address (a 4th replaces the address's oldest game, so a
crashed host can come back), 16 KB per request.

## Deploying your own

1. Fork or push this repository to your GitHub account.
2. In the [Cloudflare dashboard](https://dash.cloudflare.com/) open **Workers & Pages** → **Create** →
   **Import a repository**, connect GitHub and pick this repository. Leave the build command empty; the deploy
   command is `npx wrangler deploy`.
3. Every push to `main` deploys. The lobby is at `https://h7-lobby.<your-subdomain>.workers.dev`. Set that URL
   in the game's `H7ModEngine.ini` if you don't use the default lobby.

Deploying from a terminal instead: `npx wrangler login`, then `npm run deploy`.

## Development

```bash
npm ci
npm test            # Vitest inside the Workers runtime (Miniflare); TCP probing is off in tests
npm run typecheck
npm run dev         # local server on http://localhost:8787
npm run types       # after changing wrangler.jsonc: regenerate worker-configuration.d.ts (CI checks it)
```

| Path | |
|---|---|
| `src/index.ts` | Entry Worker: `/`, forwards `/v1/*` with the caller's IP to the Durable Object |
| `src/lobby.ts` | `Lobby` Durable Object: game list, tokens, expiry, limits, TCP probe |
| `src/validate.ts` | Validation of registration and heartbeat bodies |
| `test/lobby.test.ts` | API tests |

## License

Apache 2.0, like H7ModEngine.
