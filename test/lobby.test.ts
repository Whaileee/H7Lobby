import { exports } from "cloudflare:workers";
import { describe, expect, it, vi, afterEach } from "vitest";
import { TTL_S, MAX_GAMES_PER_IP, MAX_GAMES_PER_24 } from "../src/lobby";

const BASE = "https://lobby.test";

function call(path: string, init: RequestInit & { ip?: string; token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", init.ip ?? "203.0.113.7");
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  return exports.default.fetch(new Request(BASE + path, { ...init, headers, body }));
}

const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

const game = (over: Record<string, unknown> = {}) => ({
  name: "Ana's duel",
  type: "duel",
  map: "CM_Desert_Canyon_2",
  slots: 2,
  game_version: "2.2.1",
  engine_version: "0.2.0",
  mods: [{ name: "OnlineLobby", version: "0.1.0" }],
  settings: { turn_type: 1, quick_combat: false },
  token: newToken(),
  ...over,
});

async function register(over: Record<string, unknown> = {}, ip?: string) {
  const body = game(over);
  const res = await call("/v1/games", { method: "POST", json: body, ip });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { id: string; ip: string; port: number; verified: boolean };
  expect(data).not.toHaveProperty("token");
  return { ...data, token: body.token as string };
}

async function list(query = "") {
  const res = await call(`/v1/games${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { games: Array<Record<string, unknown>> }).games;
}

afterEach(() => vi.useRealTimers());

describe("lobby", () => {
  it("describes itself at /", async () => {
    const res = await call("/");
    expect(await res.json()).toMatchObject({ service: "h7-lobby", api: 1 });
  });

  it("registers a game with the caller's IP and lists it", async () => {
    const g = await register();
    expect(g.id).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(g.ip).toBe("203.0.113.7");
    expect(g.port).toBe(27015);
    expect(g.verified).toBe(true); // verification is off in tests: every host counts as verified
    const games = await list();
    const listed = games.find((x) => x.id === g.id)!;
    expect(listed).toMatchObject({ name: "Ana's duel", type: "duel", ip: "203.0.113.7", players: 1, slots: 2 });
    expect(listed.verified).toBe(true);
    for (const secret of ["token_hash", "token", "ckey", "owner_ip", "owner_key"]) expect(listed).not.toHaveProperty(secret);
  });

  it("stores edition and content packs", async () => {
    const content = [{ name: "mods/Conflux", version: "1a2b3c4d", files: 11 }, { name: "Data", version: "4ec8aea0", files: 13 }];
    const g = await register({ content, content_fingerprint: "1d73ef9dedc201c0" }, "203.0.113.30");
    const listed = (await list()).find((x) => x.id === g.id)!;
    expect(listed).toMatchObject({ edition: "modded", content, content_fingerprint: "1d73ef9dedc201c0" });
    const base = await register({}, "203.0.113.31");
    expect((await list()).find((x) => x.id === base.id)).toMatchObject({ edition: "base", content: [] });
    expect(((await (await call("/v1/games")).json()) as { api: number }).api).toBe(1);
  });

  it("rejects private addresses", async () => {
    for (const ip of ["192.168.1.5", "10.0.0.1", "127.0.0.1"]) {
      expect((await call("/v1/games", { method: "POST", json: game(), ip })).status).toBe(400);
    }
    expect((await call("/v1/games", { method: "POST", json: game({ ipv4: "192.168.1.5" }), ip: "2001:db8::2" })).status).toBe(400);
  });

  it("accepts empty lists sent as {} (Lua clients)", async () => {
    const g = await register({ mods: {}, content: {} }, "203.0.113.40");
    const listed = (await list()).find((x) => x.id === g.id)!;
    expect(listed).toMatchObject({ mods: [], content: [], edition: "base" });
    const res = await call("/v1/games", { method: "POST", json: game({ mods: { a: 1 } }), ip: "203.0.113.41" });
    expect(res.status).toBe(400);
  });

  it("ignores a client-supplied X-Client-IP header", async () => {
    const res = await call("/v1/games", { method: "POST", json: game(), headers: { "X-Client-IP": "198.51.100.1" } });
    expect(((await res.json()) as { ip: string }).ip).toBe("203.0.113.7");
  });

  it("uses the reported IPv4 when the request came over IPv6", async () => {
    const res = await call("/v1/games", { method: "POST", json: game(), ip: "2001:db8::1" });
    expect(res.status).toBe(400);
    const g = await register({ ipv4: "198.51.100.20" }, "2001:db8::1");
    expect(g.ip).toBe("198.51.100.20");
  });

  it("filters by type and hides private and started games", async () => {
    const duel = await register({ name: "d" });
    const skirmish = await register({ name: "s", type: "skirmish", map: "Ashan.h7m", slots: 4 }, "203.0.113.8");
    const priv = await register({ name: "p", private: true }, "203.0.113.9");
    let ids = (await list("?type=duel")).map((x) => x.id);
    expect(ids).toContain(duel.id);
    expect(ids).not.toContain(skirmish.id);
    expect(ids).not.toContain(priv.id);
    // A private game is still reachable by its id (an invite code).
    expect((await call(`/v1/games/${priv.id.toLowerCase()}`)).status).toBe(200);

    await call(`/v1/games/${duel.id}/heartbeat`, { method: "POST", token: duel.token, json: { started: true } });
    ids = (await list()).map((x) => x.id);
    expect(ids).not.toContain(duel.id);
  });

  it("requires the token for heartbeat and delete", async () => {
    const g = await register();
    for (const [path, method] of [[`/v1/games/${g.id}/heartbeat`, "POST"], [`/v1/games/${g.id}`, "DELETE"]]) {
      expect((await call(path, { method })).status).toBe(403);
      expect((await call(path, { method, token: "nope" })).status).toBe(403);
    }
    const hb = await call(`/v1/games/${g.id}/heartbeat`, { method: "POST", token: g.token, json: { players: 2 } });
    expect(hb.status).toBe(200);
    expect(((await (await call(`/v1/games/${g.id}`)).json()) as { players: number }).players).toBe(2);
    expect((await call(`/v1/games/${g.id}`, { method: "DELETE", token: g.token })).status).toBe(204);
    expect((await call(`/v1/games/${g.id}`)).status).toBe(404);
  });

  it("drops games without a heartbeat", async () => {
    const g = await register();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (TTL_S - 5) * 1000);
    expect((await list()).map((x) => x.id)).toContain(g.id);
    await call(`/v1/games/${g.id}/heartbeat`, { method: "POST", token: g.token });
    vi.setSystemTime(Date.now() + (TTL_S - 5) * 1000);
    expect((await list()).map((x) => x.id)).toContain(g.id); // the heartbeat kept it
    vi.setSystemTime(Date.now() + (TTL_S + 1) * 1000);
    expect((await list()).map((x) => x.id)).not.toContain(g.id);
    expect((await call(`/v1/games/${g.id}/heartbeat`, { method: "POST", token: g.token })).status).toBe(404);
  });

  it("keeps at most a few games per host address, replacing the oldest", async () => {
    const ids: string[] = [];
    for (let i = 0; i <= MAX_GAMES_PER_IP; i++) ids.push((await register({ name: `g${i}` }, "203.0.113.50")).id);
    const listed = (await list()).map((x) => x.id);
    expect(listed).not.toContain(ids[0]);
    for (const id of ids.slice(1)) expect(listed).toContain(id);
  });

  it("rate-limits registrations per address", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call("/v1/games", { method: "POST", json: game(), ip: "203.0.113.60" })).status;
    expect(last).toBe(429);
  });

  it.each([
    [{ type: "campaign" }, "type"],
    [{ slots: 9 }, "slots"],
    [{ name: "" }, "name"],
    [{ name: "x".repeat(41) }, "name"],
    [{ name: "bad\u0007name" }, "control"],
    [{ map: 5 }, "map"],
    [{ port: 80 }, "port"],
    [{ players: 3 }, "players"],
    [{ mods: "OnlineLobby" }, "mods"],
    [{ settings: { a: { nested: true } } }, "settings"],
    [{ private: "yes" }, "private"],
    [{ ipv4: "999.1.1.1" }, "ipv4"],
    [{ edition: "7.5" }, "edition"],
    [{ content: [{ name: "x", version: "y".repeat(17) }] }, "content"],
    [{ token: undefined }, "token"],
    [{ token: "abc" }, "token"],
    [{ token: "A".repeat(64) }, "token"],
  ].map(([over, word], i) => [over, word, `203.0.113.${100 + i}`] as const))("rejects invalid registration %j", async (over, word, ip) => {
    // Each case from its own address: failed registrations count towards the rate limit too.
    const res = await call("/v1/games", { method: "POST", json: game(over as Record<string, unknown>), ip });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(word as string);
  });

  it("rejects bodies that are not JSON objects", async () => {
    for (const body of ["not json", "[1,2]", "x".repeat(20000)]) {
      const res = await call("/v1/games", { method: "POST", body, ip: "203.0.113.80" });
      expect(res.status).toBe(400);
    }
  });

  it("answers unknown routes and methods", async () => {
    expect((await call("/v2/games")).status).toBe(404);
    expect((await call("/v1/players")).status).toBe(404);
    expect((await call("/v1/games", { method: "PUT" })).status).toBe(405);
  });

  it("accepts heartbeats only from the address the game was registered from", async () => {
    const g = await register({}, "203.0.113.90");
    const other = await call(`/v1/games/${g.id}/heartbeat`, { method: "POST", token: g.token, ip: "198.51.100.90" });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain("another address");
    expect((await call(`/v1/games/${g.id}`, { method: "DELETE", token: g.token, ip: "198.51.100.90" })).status).toBe(403);
    expect((await call(`/v1/games/${g.id}/heartbeat`, { method: "POST", token: g.token, ip: "203.0.113.90" })).status).toBe(200);
    // An IPv6 host may send from its IPv6 /48 or from the IPv4 it listed.
    const v6 = await register({ ipv4: "198.51.100.91" }, "2001:db8:1:2::5");
    for (const ip of ["2001:db8:1:ffff::9", "198.51.100.91"]) {
      expect((await call(`/v1/games/${v6.id}/heartbeat`, { method: "POST", token: v6.token, ip })).status).toBe(200);
    }
    expect((await call(`/v1/games/${v6.id}/heartbeat`, { method: "POST", token: v6.token, ip: "2001:db8:2::1" })).status).toBe(403);
  });

  it("rate-limits IPv6 callers by /48", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await call("/v1/games", { method: "POST", json: game({ ipv4: `198.18.${i}.1` }), ip: `2001:db8:77:${i}::1` })).status;
    }
    expect(last).toBe(429);
    expect((await call("/v1/games", { method: "POST", json: game({ ipv4: "198.18.20.1" }), ip: "2001:db8:78::1" })).status).toBe(201);
  });

  it("limits registrations per listed address", async () => {
    // Different callers (IPv6) all claiming one IPv4: only the first few get through to verification.
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await call("/v1/games", { method: "POST", json: game({ ipv4: "198.18.50.1" }), ip: `2001:db8:${100 + i}::1` })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[6]).toBe(429);
  });

  it("caps games per /24", async () => {
    for (let i = 0; i < MAX_GAMES_PER_24; i++) await register({}, `192.0.2.${10 + i}`);
    const res = await call("/v1/games", { method: "POST", json: game(), ip: "192.0.2.99" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toContain("network");
  });

  it("does not forward internal routes", async () => {
    expect((await call("/internal/register", { method: "POST", json: game() })).status).toBe(404);
    expect((await call("/v1/internal/precheck", { method: "POST" })).status).toBe(404);
  });

  describe("admin", () => {
    const admin = "test-admin-token";

    it("refuses without the admin token", async () => {
      expect((await call("/v1/admin/bans")).status).toBe(403);
      expect((await call("/v1/admin/bans", { token: "nope" })).status).toBe(403);
    });

    it("deletes any game", async () => {
      const g = await register({}, "203.0.113.91");
      expect((await call(`/v1/games/${g.id}`, { method: "DELETE", token: admin, ip: "198.51.100.1" })).status).toBe(204);
      expect((await call(`/v1/games/${g.id}`)).status).toBe(404);
    });

    it("bans a range: removes its games and refuses its registrations", async () => {
      const g = await register({}, "203.0.114.5");
      const keep = await register({}, "203.0.115.5");
      const put = await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "203.0.114.77/24", reason: "fake games" } });
      expect(put.status).toBe(200);
      const body = (await put.json()) as { ban: { cidr: string }; removed_games: string[] };
      expect(body.ban.cidr).toBe("203.0.114.0/24");
      expect(body.removed_games).toEqual([g.id]);
      const ids = (await list()).map((x) => x.id);
      expect(ids).not.toContain(g.id);
      expect(ids).toContain(keep.id);

      const again = await call("/v1/games", { method: "POST", json: game(), ip: "203.0.114.6" });
      expect(again.status).toBe(403);
      expect(((await again.json()) as { error: string }).error).toContain("fake games");
      // IPv6 callers can't list a banned IPv4 either.
      expect((await call("/v1/games", { method: "POST", json: game({ ipv4: "203.0.114.9" }), ip: "2001:db8:99::1" })).status).toBe(403);

      const bans = (await (await call("/v1/admin/bans", { token: admin })).json()) as { bans: Array<{ cidr: string; active: boolean }> };
      expect(bans.bans).toContainEqual(expect.objectContaining({ cidr: "203.0.114.0/24", active: true }));
      expect((await call("/v1/admin/bans?cidr=203.0.114.0/24", { method: "DELETE", token: admin })).status).toBe(204);
      expect((await call("/v1/games", { method: "POST", json: game(), ip: "203.0.114.6" })).status).toBe(201);
    });

    it("bans IPv6 prefixes and stops heartbeats", async () => {
      const g = await register({ ipv4: "198.18.60.1" }, "2001:db8:aa::1");
      const h = await register({}, "198.18.61.2");
      expect((await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "2001:db8:aa::/48" } })).status).toBe(200);
      expect((await call(`/v1/games/${g.id}`)).status).toBe(404);
      expect((await call("/v1/games", { method: "POST", json: game({ ipv4: "198.18.60.2" }), ip: "2001:db8:aa:5::1" })).status).toBe(403);
      // A ban that only matches where the heartbeat comes from ends the game at its next heartbeat.
      await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "198.18.61.3" } });
      expect((await call(`/v1/games/${h.id}/heartbeat`, { method: "POST", token: h.token, ip: "198.18.61.2" })).status).toBe(200);
      await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "198.18.61.2", until: Date.now() + 60_000 } });
      expect((await call(`/v1/games/${h.id}`)).status).toBe(404); // removed at once: its address is in the range
    });

    it("refuses very wide ranges without force", async () => {
      expect((await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "10.0.0.0/8" } })).status).toBe(400);
      expect((await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "2001::/16" } })).status).toBe(400);
      expect((await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "10.0.0.0/8", force: true } })).status).toBe(200);
      expect((await call("/v1/admin/bans", { method: "PUT", token: admin, json: { cidr: "not an ip" } })).status).toBe(400);
    });
  });
});
