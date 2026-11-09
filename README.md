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
     └────────────────── game traffic: UDP 27015, direct ───────────────────────────────┘
     (the lobby checks the host on TCP 27015 before listing it)
```

## API

All bodies are JSON. Errors are `{"error": "message"}` with a 4xx status.

| Call | |
|---|---|
| `GET /` | `{service, api}` |
| `GET /v1/games?type=duel\|skirmish` | `{api, games: [...], heartbeat_s, ttl_s}`: open public games, newest first (private and started games are left out) |
| `GET /v1/games/:id` | One game, including private ones: the id works as an invite code |
| `POST /v1/games` | Register a game (below). The lobby first [verifies the host](#host-verification). `201 {id, ip, port, verified, heartbeat_s, ttl_s}`; `403` when verification failed (`{error, ip, port}`) or the address is banned; `429`/`503` at a limit |
| `POST /v1/games/:id/heartbeat` | `Authorization: Bearer <token>`, from the address the game was registered from (or the listed IPv4). Optional body `{players, started}`. Send every `heartbeat_s` (15) seconds; a game without one for `ttl_s` (60) seconds is removed. `403` from another address: register again |
| `DELETE /v1/games/:id` | `Authorization: Bearer <token>` (same address rule), or the admin token. `204` |
| `GET /v1/admin/bans` | Admin token. `{bans: [{cidr, reason, until?, created, active}]}` |
| `PUT /v1/admin/bans` | Admin token. `{cidr, reason?, until?, force?}`: ban an address or range (IPv4 or IPv6, e.g. `198.51.100.0/24`); its games are removed at once. Ranges wider than /16 (IPv4) or /32 (IPv6) need `"force": true`. `until` is ms since the epoch |
| `DELETE /v1/admin/bans?cidr=` | Admin token. Lift a ban. `204` |
| `POST /v1/reports` | A [desync report](#desync-reports) from a player who opted in. `201 {id}`; `413` over 144 KB; `429` at a limit; `503` when the day's reports are full |
| `GET /v1/admin/reports?game=&session=&since=&limit=` | Admin token. `{reports: [...]}`, newest first, without the logs (`limit` default 100, at most 500; `since` in ms since the epoch) |
| `GET /v1/admin/reports/:id` | Admin token. One report with its `log` |
| `DELETE /v1/admin/reports/:id` | Admin token. `204` |

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
| `token` | 64 lowercase hex characters (32 random bytes) the host generates: its Bearer token for this game and the key it [proves itself](#host-verification) with. Never shown to anyone else |
| `settings` | Optional flat object of strings (up to 2048 characters)/numbers/booleans (turn type, random map string, ...), up to 32 keys |
| `ipv4` | Optional; only used when the host's request reached Cloudflare over IPv6 (the game listens on IPv4). The host's mod gets it from the router through UPnP. Verified like any other address |

The host's address is the IP its request came from, as Cloudflare saw it (private addresses are refused).

### Host verification

Players' games connect straight to a listed address, so the lobby lists only hosts that prove they are at the
address they claim: before a game is stored, the lobby opens a TCP connection to `ip:port` (the game itself uses
UDP on that port, so TCP is free for this) and asks the host to answer a challenge only the holder of the game's
`token` can answer. A game that fails is not listed. This stops fake listings that point players at someone else's
PC, and makes flooding the list cost one public address with an open port per 3 games.

All ASCII; HMAC keys are the bytes of the hex strings:

| | |
|---|---|
| `ckey` | `hex(HMAC-SHA256(key = token, msg = "H7LOBBY challenge key"))`: what the host's responder holds (never the token itself) |
| lobby → host | `"H7LOBBY 1 " + nonce + "\n"`, nonce = 32 lowercase hex characters (43 bytes) |
| host → lobby | `hex(HMAC-SHA256(key = ckey, msg = nonce)) + "\n"` (65 bytes), then close |

Timeout 3 s. The 403 names the reason (`connection refused`, `timeout`, `wrong answer`, `closed early`) only
when the listed address is the caller's own. Test vector: token `0011…eeff` (`00112233445566778899aabbccddeeff`
twice) gives ckey `00f01b98…edc3cc`; nonce `0123456789abcdef0123456789abcdef` gives the reply
`5794bf2e5e14ea5f4f7eeca473024143a18e94fa4dd32d5274dd6219a3720350` (`test/verify.test.ts`).
`node test/responder.mjs` is a reference host side. Hosts therefore need **UDP and TCP** on their game port
forwarded (H7ModEngine maps both through UPnP).

### Desync reports

Players can opt in (OnlineLobby setting "Send desync reports", off by default) to send the tail of their game's
multiplayer trace when the game goes out of sync, so desyncs can be diagnosed. The lobby keeps reports for 30 days
in their own Durable Object (`src/reports.ts`) and stores **no IP address** with them (the caller's address only
feeds the per-minute limit, in memory). Report body:

| Field | |
|---|---|
| `session` | 32 lowercase hex characters: one game session on one PC |
| `game` | Optional lobby game id (both players of a lobby game send the same one); empty for a LAN game |
| `role` | `"host"` or `"client"` |
| `player` | Optional, -1..7 (the player's slot) |
| `trigger` | What made the client send it: comma-separated tags such as `OOS`, `OOSREMOTE`, `LATE`, `STUCK` |
| `uac` | Optional integer: the game's action counter at the trigger |
| `map`, `simturns` | Optional: map name (up to 128 characters), simultaneous turns |
| `game_version`, `engine_version` | Strings, up to 32 characters |
| `mods`, `edition`, `content_fingerprint` | Optional, as in a registration |
| `log` | The trace: text lines (tabs and line breaks allowed), up to 128 KB. Format: H7ModEngine `dist/lib/mpsync.lua` |

Limits: 3 reports a minute per caller (5 at the edge), 5 per session, 300 a day in all, 2000 stored (the oldest
go first). `tools/fetch_reports.py` in H7ModEngine downloads them and runs the trace diff on each game's pair.

### Limits

Per caller (IPv6: per /48) 10 registrations a minute, failed ones included (also enforced at the edge by a
Workers rate-limit binding); 5 verification attempts a minute per listed address; 3 games per address (a 4th
replaces the address's oldest game, so a crashed host can come back); 8 games per IPv4 /24; 300 games in all;
16 KB per request.

### Admin

Set a secret with `npx wrangler secret put ADMIN_TOKEN` (or in the dashboard: Worker → Settings → Variables and
Secrets). Without it the admin routes answer 404. Example:

```bash
curl -X PUT https://h7-lobby.whaileee.workers.dev/v1/admin/bans -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"cidr": "198.51.100.0/24", "reason": "fake games"}'
curl https://h7-lobby.whaileee.workers.dev/v1/admin/reports -H "Authorization: Bearer $ADMIN_TOKEN"
```

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
npm test            # Vitest inside the Workers runtime (Miniflare); host verification is off in tests
npm run typecheck
npm run dev         # local server on http://localhost:8787
# End to end with real TCP challenges against a local host:
npx wrangler dev --var DEV_ALLOW_PRIVATE:1
node test/responder.mjs register http://127.0.0.1:8787 27990
npm run types       # after changing wrangler.jsonc: regenerate worker-configuration.d.ts (CI checks it)
```

| Path | |
|---|---|
| `src/index.ts` | Entry Worker: `/`, registration with host verification, forwards the other `/v1/*` routes with the caller's IP to the Durable Object |
| `src/lobby.ts` | `Lobby` Durable Object: game list, tokens, expiry, limits, bans |
| `src/verify.ts` | Host verification (the TCP challenge) |
| `src/ipaddr.ts` | Address parsing, rate-limit keys, CIDR matching |
| `src/validate.ts` | Validation of registration and heartbeat bodies |
| `test/lobby.test.ts`, `test/verify.test.ts` | API and protocol tests |
| `test/responder.mjs` | Reference host side of the challenge (end-to-end tests) |

## License

Apache 2.0, like H7ModEngine.
