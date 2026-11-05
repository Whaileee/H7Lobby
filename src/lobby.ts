// The Lobby Durable Object: the list of hosted games and the ban list.
//
// A host registers its game (through the entry Worker, which verifies it: src/index.ts, src/verify.ts), then sends a
// heartbeat every HEARTBEAT_S seconds from the same address; a game without a heartbeat for TTL_S seconds is
// dropped. Games and bans are kept in Durable Object storage (so a restart of the object keeps them) and cached in
// memory. Expired games are pruned lazily on every request.
//
// Routes under /internal/ are only reachable from the entry Worker (it never forwards a path outside /v1/), which
// sets X-Client-IP (the caller) and X-Host-IP (the address being listed).
import { DurableObject } from "cloudflare:workers";
import { API_VERSION, MAX_BODY } from "./constants";
import type { Env } from "./index";
import { block24, inCidr, parseCidr, rateKey, type Cidr } from "./ipaddr";
import { InvalidInput, parseHeartbeat, parseRegistration, type Registration } from "./validate";
import { deriveChallengeKey, timingSafeEqualStr } from "./verify";

export const HEARTBEAT_S = 15;
export const TTL_S = 60;
export const MAX_GAMES_PER_IP = 3;
export const MAX_GAMES_PER_24 = 8;
export const MAX_GAMES = 300;
export const MAX_REGISTRATIONS_PER_MINUTE = 10; // per caller (IPv6: per /48), failed verifications included
export const MAX_CHALLENGES_PER_MINUTE = 5;     // per host address being verified

interface StoredGame extends Omit<Registration, "ipv4" | "token"> {
  id: string;
  token_hash: string;
  ckey: string;      // the challenge key (src/verify.ts), kept for re-verification
  ip: string;        // the host address players connect to
  owner_ip: string;  // the address the registration came from (differs from ip for IPv6 hosts)
  owner_key: string; // rateKey(owner_ip): heartbeats must come from here (or from ip)
  verified: boolean;
  started: boolean;
  created: number;   // ms since epoch
  updated: number;
}

interface Ban {
  cidr: string;
  reason: string;
  until?: number; // ms since epoch; permanent when absent
  created: number;
}

// What other players see (no secrets, no owner address).
function publicView(g: StoredGame) {
  const { token_hash: _t, ckey: _c, owner_ip: _o, owner_key: _k, ...rest } = g;
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

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const bearer = (request: Request) => {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

export class Lobby extends DurableObject<Env> {
  private games = new Map<string, StoredGame>();
  private bans = new Map<string, Ban & { range: Cidr }>();
  private attempts = new Map<string, number[]>(); // "reg:<rateKey>" / "chal:<hostIp>" -> times (rate limits)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<StoredGame>({ prefix: "game:" });
      const stale: string[] = [];
      for (const [key, g] of stored) {
        if (g.verified === undefined) stale.push(key); // registered before verification existed
        else this.games.set(g.id, g);
      }
      if (stale.length) await ctx.storage.delete(stale);
      for (const b of (await ctx.storage.list<Ban>({ prefix: "ban:" })).values()) {
        const range = parseCidr(b.cidr);
        if (range) this.bans.set(range.text, { ...b, range });
      }
    });
  }

  private async prune(now: number) {
    const expired = [...this.games.values()].filter((g) => now - g.updated > TTL_S * 1000);
    for (const g of expired) this.games.delete(g.id);
    if (expired.length) await this.ctx.storage.delete(expired.map((g) => `game:${g.id}`));
    for (const t of [...this.attempts.keys()]) {
      const recent = this.attempts.get(t)!.filter((x) => now - x < 60_000);
      if (recent.length) this.attempts.set(t, recent);
      else this.attempts.delete(t);
    }
  }

  private async save(g: StoredGame) {
    this.games.set(g.id, g);
    await this.ctx.storage.put(`game:${g.id}`, g);
  }

  private async remove(g: StoredGame) {
    this.games.delete(g.id);
    await this.ctx.storage.delete(`game:${g.id}`);
  }

  private banned(ip: string, now: number): Ban | undefined {
    for (const b of this.bans.values()) if ((b.until === undefined || b.until > now) && inCidr(ip, b.range)) return b;
    return undefined;
  }

  private bannedError(b: Ban) {
    return error(`this address is banned from the lobby${b.reason ? ` (${b.reason})` : ""}`, 403);
  }

  // Counts one attempt under `key`; false when `limit` attempts were already made in the last minute.
  private count(key: string, limit: number, now: number): boolean {
    const recent = this.attempts.get(key) ?? [];
    if (recent.length >= limit) return false;
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  private isAdmin(request: Request): boolean {
    const secret = this.env.ADMIN_TOKEN;
    return !!secret && timingSafeEqualStr(bearer(request), secret);
  }

  private async isOwner(request: Request, g: StoredGame): Promise<boolean> {
    const token = bearer(request);
    return token !== "" && (await sha256(token)) === g.token_hash;
  }

  private fromHost(ip: string, g: StoredGame) {
    return rateKey(ip) === g.owner_key || ip === g.ip;
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
    const parts = url.pathname.split("/").filter(Boolean);
    const ip = request.headers.get("X-Client-IP") ?? "127.0.0.1";
    try {
      if (parts[0] === "internal" && request.method === "POST") {
        const hostIp = request.headers.get("X-Host-IP") ?? ip;
        if (parts[1] === "precheck") return this.precheck(ip, hostIp, now);
        if (parts[1] === "register") return await this.register(request, ip, hostIp, now);
        return error("not found", 404);
      }
      if (parts[0] !== "v1") return error("not found", 404);
      if (parts[1] === "admin") return await this.admin(request, parts, url, now);
      if (parts[1] !== "games" || parts.length > 4) return error("not found", 404);
      const id = parts[2];
      const action = parts[3];
      if (!id) {
        if (request.method === "GET") return this.list(url);
        return error("method not allowed", 405);
      }
      const g = this.games.get(id.toUpperCase());
      if (!g) return error("no such game (it may have expired)", 404);
      if (!action) {
        if (request.method === "GET") return json(publicView(g));
        if (request.method === "DELETE") {
          if (!this.isAdmin(request)) {
            if (!(await this.isOwner(request, g))) return error("wrong or missing token", 403);
            if (!this.fromHost(ip, g)) return error("this game was registered from another address", 403);
          }
          await this.remove(g);
          return new Response(null, { status: 204 });
        }
        return error("method not allowed", 405);
      }
      if (action === "heartbeat" && request.method === "POST") {
        if (!(await this.isOwner(request, g))) return error("wrong or missing token", 403);
        if (!this.fromHost(ip, g)) return error("this game was registered from another address", 403);
        const ban = this.banned(ip, now) ?? this.banned(g.ip, now);
        if (ban) {
          await this.remove(g);
          return this.bannedError(ban);
        }
        const hb = parseHeartbeat(await this.readJson(request));
        if (hb.players !== undefined) g.players = Math.min(hb.players, g.slots);
        if (hb.started !== undefined) g.started = hb.started;
        g.updated = now;
        await this.save(g);
        return json({ ok: true, heartbeat_s: HEARTBEAT_S, ttl_s: TTL_S });
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
      .filter((g) => g.verified && !g.private && !g.started && (!type || g.type === type))
      .sort((a, b) => b.created - a.created)
      .map(publicView);
    return json({ api: API_VERSION, games, heartbeat_s: HEARTBEAT_S, ttl_s: TTL_S });
  }

  // Would a new game for hostIp fit? (null: yes.) A host already at its per-address limit replaces its oldest game,
  // so it never grows the /24 or the total.
  private capError(hostIp: string): Response | null {
    const all = [...this.games.values()];
    if (all.filter((g) => g.ip === hostIp).length >= MAX_GAMES_PER_IP) return null;
    const block = block24(hostIp);
    if (block && all.filter((g) => block24(g.ip) === block).length >= MAX_GAMES_PER_24) {
      return error("too many games from your network, try again later", 429);
    }
    if (all.length >= MAX_GAMES) return error("the lobby is full, try again later", 503);
    return null;
  }

  // Before the entry Worker spends a socket on verifying hostIp.
  private precheck(ip: string, hostIp: string, now: number): Response {
    const ban = this.banned(ip, now) ?? this.banned(hostIp, now);
    if (ban) return this.bannedError(ban);
    if (!this.count(`reg:${rateKey(ip)}`, MAX_REGISTRATIONS_PER_MINUTE, now)) {
      return error("too many registrations, try again in a minute", 429);
    }
    if (!this.count(`chal:${hostIp}`, MAX_CHALLENGES_PER_MINUTE, now)) {
      return error("too many registrations for this address, try again in a minute", 429);
    }
    return this.capError(hostIp) ?? json({ ok: true });
  }

  // Called by the entry Worker once the host passed verification (or verification is off).
  private async register(request: Request, ip: string, hostIp: string, now: number): Promise<Response> {
    const reg = parseRegistration(await this.readJson(request));
    const capped = this.capError(hostIp); // again: other registrations may have landed while we verified
    if (capped) return capped;

    const mine = [...this.games.values()].filter((g) => g.ip === hostIp);
    if (mine.length >= MAX_GAMES_PER_IP) {
      // A host that crashed and re-registers replaces its oldest game instead of being locked out. (Only the
      // address's real owner gets here: everyone else fails verification.)
      await this.remove(mine.sort((a, b) => a.updated - b.updated)[0]);
    }

    let id = newId();
    while (this.games.has(id)) id = newId();
    const { ipv4: _ignored, token, ...fields } = reg;
    const game: StoredGame = {
      ...fields,
      id,
      token_hash: await sha256(token),
      ckey: await deriveChallengeKey(token),
      ip: hostIp,
      owner_ip: ip,
      owner_key: rateKey(ip),
      verified: true,
      started: false,
      created: now,
      updated: now,
    };
    await this.save(game);
    return json({ id, ip: hostIp, port: game.port, verified: true, heartbeat_s: HEARTBEAT_S, ttl_s: TTL_S }, 201);
  }

  // /v1/admin/bans: GET (list), PUT {cidr, reason?, until?, force?}, DELETE ?cidr=
  private async admin(request: Request, parts: string[], url: URL, now: number): Promise<Response> {
    if (!this.env.ADMIN_TOKEN) return error("not found", 404);
    if (!this.isAdmin(request)) return error("wrong or missing admin token", 403);
    if (parts[2] !== "bans" || parts.length > 3) return error("not found", 404);

    if (request.method === "GET") {
      const bans = [...this.bans.values()].map(({ range: _r, ...b }) => ({ ...b, active: b.until === undefined || b.until > now }));
      return json({ bans });
    }
    if (request.method === "PUT") {
      const body = (await this.readJson(request)) as Record<string, unknown> | undefined;
      if (typeof body !== "object" || body === null) throw new InvalidInput("body must be a JSON object");
      const range = typeof body.cidr === "string" ? parseCidr(body.cidr) : null;
      if (!range) throw new InvalidInput("cidr must be an address or a range like 198.51.100.0/24");
      if ((range.v4 ? range.prefix < 16 : range.prefix < 32) && body.force !== true) {
        throw new InvalidInput(`${range.text} is a very wide range; send "force": true to ban it anyway`);
      }
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 200)) {
        throw new InvalidInput("reason must be a string of at most 200 characters");
      }
      if (body.until !== undefined && (typeof body.until !== "number" || !Number.isFinite(body.until))) {
        throw new InvalidInput("until must be a time in ms since the epoch");
      }
      const ban: Ban = { cidr: range.text, reason: (body.reason as string | undefined) ?? "", created: now };
      if (body.until !== undefined) ban.until = body.until as number;
      this.bans.set(range.text, { ...ban, range });
      await this.ctx.storage.put(`ban:${range.text}`, ban);
      const hit = [...this.games.values()].filter((g) => inCidr(g.ip, range) || inCidr(g.owner_ip, range));
      for (const g of hit) await this.remove(g);
      return json({ ban, removed_games: hit.map((g) => g.id) });
    }
    if (request.method === "DELETE") {
      const range = parseCidr(url.searchParams.get("cidr") ?? "");
      if (!range || !this.bans.has(range.text)) return error("no such ban", 404);
      this.bans.delete(range.text);
      await this.ctx.storage.delete(`ban:${range.text}`);
      return new Response(null, { status: 204 });
    }
    return error("method not allowed", 405);
  }
}
