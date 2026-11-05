import { exports } from "cloudflare:workers";
import { describe, expect, it, vi, afterEach } from "vitest";
import { TTL_S, MAX_GAMES_PER_IP } from "../src/lobby";

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

const game = (over: Record<string, unknown> = {}) => ({
  name: "Ana's duel",
  type: "duel",
  map: "CM_Desert_Canyon_2",
  slots: 2,
  game_version: "2.2.1",
  engine_version: "0.2.0",
  mods: [{ name: "OnlineLobby", version: "0.1.0" }],
  settings: { turn_type: 1, quick_combat: false },
  ...over,
});

async function register(over: Record<string, unknown> = {}, ip?: string) {
  const res = await call("/v1/games", { method: "POST", json: game(over), ip });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string; ip: string; port: number; reachable: boolean | null };
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
    expect(g.reachable).toBeNull(); // probing is off in tests
    const games = await list();
    const listed = games.find((x) => x.id === g.id)!;
    expect(listed).toMatchObject({ name: "Ana's duel", type: "duel", ip: "203.0.113.7", players: 1, slots: 2 });
    expect(listed).not.toHaveProperty("token_hash");
    expect(listed).not.toHaveProperty("token");
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

  it("requires the token for heartbeat, probe and delete", async () => {
    const g = await register();
    for (const [path, method] of [[`/v1/games/${g.id}/heartbeat`, "POST"], [`/v1/games/${g.id}/probe`, "POST"], [`/v1/games/${g.id}`, "DELETE"]]) {
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
});
