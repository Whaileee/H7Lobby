// The Lobby Durable Object: the list of hosted games.
//
// A host registers its game, then sends a heartbeat every HEARTBEAT_S seconds; a game without a heartbeat for
// TTL_S seconds is dropped. Games are kept in Durable Object storage (so a restart of the object keeps them) and
// cached in memory. Expired games are pruned lazily on every request.
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { API_VERSION, type Env } from "./index";
import { InvalidInput, isIPv4, isPrivateIPv4, parseHeartbeat, parseRegistration, type Registration } from "./validate";

export const HEARTBEAT_S = 15;
export const TTL_S = 60;
export const MAX_GAMES_PER_IP = 3;
export const MAX_REGISTRATIONS_PER_MINUTE = 10;
const PROBE_TIMEOUT_MS = 3000;
const MAX_BODY = 16 * 1024;

interface StoredGame extends Omit<Registration, "ipv4"> {
  id: string;
  token_hash: string;
  ip: string;
  reachable: boolean | null; // null: not probed
  started: boolean;
  created: number; // ms since epoch
  updated: number;
}

// What other players see (no token, no internal fields).
function publicView(g: StoredGame) {
  const { token_hash: _t, ...rest } = g;
  return { ...rest, age_s: Math.round((Date.now() - g.created) / 1000) };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (message: string, status: number) => json({ error: message }, status);

// Invite-code style ids: 6 characters without look-alikes (0/O, 1/I/L).
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Can another player open a TCP connection to ip:port? (The game's mesh beacon listens on TCP 27015.)
async function probe(ip: string, port: number): Promise<boolean> {
  let socket: ReturnType<typeof connect> | undefined;
  try {
    socket = connect({ hostname: ip, port });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS));
    await Promise.race([socket.opened, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    socket?.close().catch(() => {});
  }
}

export class Lobby extends DurableObject<Env> {
  private games = new Map<string, StoredGame>();
  private registrations = new Map<string, number[]>(); // ip -> registration times (rate limit)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<StoredGame>({ prefix: "game:" });
      for (const g of stored.values()) this.games.set(g.id, g);
    });
  }

  private async prune(now: number) {
    const expired = [...this.games.values()].filter((g) => now - g.updated > TTL_S * 1000);
    for (const g of expired) this.games.delete(g.id);
    if (expired.length) await this.ctx.storage.delete(expired.map((g) => `game:${g.id}`));
  }

  private async save(g: StoredGame) {
    this.games.set(g.id, g);
    await this.ctx.storage.put(`game:${g.id}`, g);
  }

  private async authorized(request: Request, g: StoredGame): Promise<boolean> {
    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    return token !== "" && (await sha256(token)) === g.token_hash;
  }

  private async readJson(request: Request): Promise<unknown> {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new InvalidInput("body too large");
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new InvalidInput("body is not valid JSON");
    }
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    await this.prune(now);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", "games", id?, action?]
    const ip = request.headers.get("X-Client-IP") ?? "127.0.0.1";
    try {
      if (parts[1] !== "games" || parts.length > 4) return error("not found", 404);
      const id = parts[2];
      const action = parts[3];
      if (!id) {
        if (request.method === "GET") return this.list(url);
        if (request.method === "POST") return await this.register(request, ip, now);
        return error("method not allowed", 405);
      }
      const g = this.games.get(id.toUpperCase());
      if (!g) return error("no such game (it may have expired)", 404);
      if (!action) {
        if (request.method === "GET") return json(publicView(g));
        if (request.method === "DELETE") {
          if (!(await this.authorized(request, g))) return error("wrong or missing token", 403);
          this.games.delete(g.id);
          await this.ctx.storage.delete(`game:${g.id}`);
          return new Response(null, { status: 204 });
        }
        return error("method not allowed", 405);
      }
      if (action === "heartbeat" && request.method === "POST") {
        if (!(await this.authorized(request, g))) return error("wrong or missing token", 403);
        const hb = parseHeartbeat(await this.readJson(request));
        if (hb.players !== undefined) g.players = Math.min(hb.players, g.slots);
        if (hb.started !== undefined) g.started = hb.started;
        g.updated = now;
        await this.save(g);
        return json({ ok: true, heartbeat_s: HEARTBEAT_S, ttl_s: TTL_S });
      }
      if (action === "probe" && request.method === "POST") {
        if (!(await this.authorized(request, g))) return error("wrong or missing token", 403);
        g.reachable = this.env.PROBE === "off" ? null : await probe(g.ip, g.port);
        await this.save(g);
        return json({ reachable: g.reachable });
      }
      return error("not found", 404);
    } catch (e) {
      if (e instanceof InvalidInput) return error(e.message, 400);
      throw e;
    }
  }

  private list(url: URL): Response {
    const type = url.searchParams.get("type");
    const games = [...this.games.values()]
      .filter((g) => !g.private && !g.started && (!type || g.type === type))
      .sort((a, b) => b.created - a.created)
      .map(publicView);
    return json({ api: API_VERSION, games, heartbeat_s: HEARTBEAT_S, ttl_s: TTL_S });
  }

  private async register(request: Request, ip: string, now: number): Promise<Response> {
    const recent = (this.registrations.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_REGISTRATIONS_PER_MINUTE) return error("too many registrations, try again in a minute", 429);
    recent.push(now);
    this.registrations.set(ip, recent);

    const reg = parseRegistration(await this.readJson(request));

    // The address other players connect to. Cloudflare reports what the host's request came from; if that is
    // IPv6 (the game listens on IPv4), use the IPv4 the host's router reported through UPnP.
    let hostIp = ip;
    if (!isIPv4(ip)) {
      if (!reg.ipv4) return error("your request came over IPv6; send your public IPv4 address in ipv4", 400);
      hostIp = reg.ipv4;
    }
    if (isPrivateIPv4(hostIp)) return error(`${hostIp} is not a public address`, 400);

    const mine = [...this.games.values()].filter((g) => g.ip === hostIp);
    if (mine.length >= MAX_GAMES_PER_IP) {
      // A host that crashed and re-registers replaces its oldest game instead of being locked out.
      const oldest = mine.sort((a, b) => a.updated - b.updated)[0];
      this.games.delete(oldest.id);
      await this.ctx.storage.delete(`game:${oldest.id}`);
    }

    let id = newId();
    while (this.games.has(id)) id = newId();
    const token = newToken();
    const { ipv4: _ignored, ...fields } = reg;
    const game: StoredGame = {
      ...fields,
      id,
      token_hash: await sha256(token),
      ip: hostIp,
      reachable: this.env.PROBE === "off" ? null : await probe(hostIp, reg.port),
      started: false,
      created: now,
      updated: now,
    };
    await this.save(game);
    return json({ id, token, ip: hostIp, port: game.port, reachable: game.reachable, heartbeat_s: HEARTBEAT_S, ttl_s: TTL_S }, 201);
  }
}
