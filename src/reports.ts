// The Reports Durable Object: opt-in desync reports from H7ModEngine's OnlineLobby (README "Desync reports").
//
// A report is the tail of one player's multiplayer trace, sent when their game detected a desync. Reports are kept
// in this object's SQLite storage for REPORT_TTL_DAYS days and read through the admin routes. No IP address is
// stored: the caller's address only feeds the in-memory per-minute limit (the entry Worker also rate-limits at the
// edge). A separate object from Lobby, so large report bodies never slow down the game list.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { rateKey } from "./ipaddr";
import { InvalidInput, MAX_REPORT_LOG, parseReport } from "./validate";
import { timingSafeEqualStr } from "./verify";

export const REPORT_TTL_DAYS = 30;
export const MAX_REPORTS = 2000;               // stored at most; the oldest go first
export const MAX_REPORTS_PER_DAY = 300;        // accepted from everyone together in 24 hours
export const MAX_REPORTS_PER_SESSION = 5;      // per game session (the client sends at most 3)
export const MAX_REPORTS_PER_MINUTE = 3;       // per caller (IPv6: per /48), in memory only
export const MAX_REPORT_BODY = MAX_REPORT_LOG + 16 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (message: string, status: number) => json({ error: message }, status);

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

const bearer = (request: Request) => {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  created: number;
  session: string;
  game: string;
  role: string;
  trigger: string;
  uac: number;
  meta: string;
  size: number;
}

// The list view of a report: everything but the log.
function summary(r: Row) {
  const { meta, ...rest } = r;
  return { ...rest, ...(JSON.parse(meta) as Record<string, unknown>) };
}

export class Reports extends DurableObject<Env> {
  private sql: SqlStorage;
  private attempts = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, created INTEGER NOT NULL, session TEXT NOT NULL, game TEXT NOT NULL, role TEXT NOT NULL,
      trigger TEXT NOT NULL, uac INTEGER NOT NULL, meta TEXT NOT NULL, log TEXT NOT NULL, size INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS reports_created ON reports(created)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS reports_game ON reports(game)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS reports_session ON reports(session)");
  }

  private count(key: string, now: number): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_REPORTS_PER_MINUTE) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  private isAdmin(request: Request): boolean {
    const secret = this.env.ADMIN_TOKEN;
    return !!secret && timingSafeEqualStr(bearer(request), secret);
  }

  private scalar(query: string, ...args: SqlStorageValue[]): number {
    return Number(this.sql.exec(query, ...args).one()["n"]);
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "internal" && parts[1] === "report" && request.method === "POST") {
        return await this.add(request, request.headers.get("X-Client-IP") ?? "127.0.0.1", now);
      }
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "reports" && parts.length <= 4) {
        return this.admin(request, parts[3], url);
      }
      return error("not found", 404);
    } catch (e) {
      if (e instanceof InvalidInput) return error(e.message, 400);
      throw e;
    }
  }

  private async add(request: Request, ip: string, now: number): Promise<Response> {
    if (!this.count(rateKey(ip), now)) return error("too many reports, try again in a minute", 429);
    const text = await request.text();
    if (text.length > MAX_REPORT_BODY) throw new InvalidInput("body too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new InvalidInput("body is not valid JSON");
    }
    const r = parseReport(body);

    // Retention first, so the caps below count only what is kept.
    this.sql.exec("DELETE FROM reports WHERE created < ?", now - REPORT_TTL_DAYS * DAY_MS);
    if (this.scalar("SELECT COUNT(*) AS n FROM reports WHERE created > ?", now - DAY_MS) >= MAX_REPORTS_PER_DAY) {
      return error("the lobby takes no more reports today", 503);
    }
    if (this.scalar("SELECT COUNT(*) AS n FROM reports WHERE session = ?", r.session) >= MAX_REPORTS_PER_SESSION) {
      return error("enough reports from this game", 429);
    }

    const { session, game, role, trigger, uac, log, ...meta } = r;
    const id = newId();
    this.sql.exec(
      "INSERT INTO reports (id, created, session, game, role, trigger, uac, meta, log, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, now, session, game, role, trigger, uac, JSON.stringify(meta), log, log.length,
    );
    const total = this.scalar("SELECT COUNT(*) AS n FROM reports");
    if (total > MAX_REPORTS) {
      this.sql.exec("DELETE FROM reports WHERE id IN (SELECT id FROM reports ORDER BY created LIMIT ?)", total - MAX_REPORTS);
    }
    return json({ id }, 201);
  }

  // /v1/admin/reports: GET ?game=&session=&since=&limit= (newest first, without logs); /v1/admin/reports/:id: GET
  // (with the log), DELETE.
  private admin(request: Request, id: string | undefined, url: URL): Response {
    if (!this.env.ADMIN_TOKEN) return error("not found", 404);
    if (!this.isAdmin(request)) return error("wrong or missing admin token", 403);
    const columns = "id, created, session, game, role, trigger, uac, meta, size";

    if (!id) {
      if (request.method !== "GET") return error("method not allowed", 405);
      const where: string[] = [];
      const args: SqlStorageValue[] = [];
      const game = url.searchParams.get("game");
      if (game) where.push("game = ?"), args.push(game.toUpperCase());
      const session = url.searchParams.get("session");
      if (session) where.push("session = ?"), args.push(session);
      const since = Number(url.searchParams.get("since") ?? "");
      if (Number.isFinite(since) && since > 0) where.push("created >= ?"), args.push(since);
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(url.searchParams.get("limit") ?? "100")) || 100));
      const rows = this.sql
        .exec<Row>(`SELECT ${columns} FROM reports ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC LIMIT ?`, ...args, limit)
        .toArray();
      return json({ reports: rows.map(summary) });
    }

    if (request.method === "GET") {
      const rows = this.sql.exec<Row & { log: string }>(`SELECT ${columns}, log FROM reports WHERE id = ?`, id.toUpperCase()).toArray();
      if (!rows.length) return error("no such report", 404);
      const { log, ...row } = rows[0];
      return json({ ...summary(row as Row), log });
    }
    if (request.method === "DELETE") {
      const n = this.sql.exec("DELETE FROM reports WHERE id = ?", id.toUpperCase()).rowsWritten;
      return n ? new Response(null, { status: 204 }) : error("no such report", 404);
    }
    return error("method not allowed", 405);
  }
}
