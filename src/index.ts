// Entry Worker: answers /, registers games (with host verification), takes desync reports and forwards the other
// /v1/* routes to the single Lobby Durable Object (reports: the single Reports object), passing the caller's IP.
//
// Registration is handled here rather than in the Durable Object because verifying a host means waiting up to a few
// seconds on a TCP socket: a Durable Object is billed for wall-clock time while it waits, a Worker for CPU only.
import { Lobby } from "./lobby";
import { MAX_REPORT_BODY, Reports } from "./reports";
import { API_VERSION, MAX_BODY } from "./constants";
import { isIPv4, isPrivateIPv4, rateKey } from "./ipaddr";
import { InvalidInput, parseRegistration } from "./validate";
import { deriveChallengeKey, verifyHost } from "./verify";

export { Lobby, Reports };

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  REPORTS: DurableObjectNamespace<Reports>;
  VERIFY: string;             // "on": hosts must pass the TCP challenge (src/verify.ts); "off" (tests): trusted
  DEV_ALLOW_PRIVATE?: string; // "1": accept private host addresses (local `wrangler dev` only)
  ADMIN_TOKEN?: string;       // secret (`wrangler secret put ADMIN_TOKEN`); admin routes answer 404 without it
  REGISTER_LIMIT?: RateLimit; // edge rate limit on registrations, before the Durable Object sees them
  REPORT_LIMIT?: RateLimit;   // edge rate limit on desync reports
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (message: string, status: number) => json({ error: message }, status);

const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName("global"));
const reports = (env: Env) => env.REPORTS.get(env.REPORTS.idFromName("global"));

async function report(request: Request, env: Env, clientIp: string): Promise<Response> {
  if (env.REPORT_LIMIT) {
    const { success } = await env.REPORT_LIMIT.limit({ key: rateKey(clientIp) });
    if (!success) return error("too many reports, try again in a minute", 429);
  }
  // Read (and cap) the body here: a Durable Object is billed for wall-clock time while a large upload trickles in.
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_REPORT_BODY) return error("body too large", 413);
  const text = await request.text();
  if (text.length > MAX_REPORT_BODY) return error("body too large", 413);
  return reports(env).fetch("https://reports/internal/report", {
    method: "POST",
    headers: { "X-Client-IP": clientIp, "Content-Type": "application/json" },
    body: text,
  });
}

async function register(request: Request, env: Env, clientIp: string): Promise<Response> {
  if (env.REGISTER_LIMIT) {
    const { success } = await env.REGISTER_LIMIT.limit({ key: rateKey(clientIp) });
    if (!success) return error("too many registrations, try again in a minute", 429);
  }

  let reg;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new InvalidInput("body too large");
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new InvalidInput("body is not valid JSON");
    }
    reg = parseRegistration(body);
  } catch (e) {
    if (e instanceof InvalidInput) return error(e.message, 400);
    throw e;
  }

  // The address other players connect to: what Cloudflare saw, or over IPv6 (the game listens on IPv4) the IPv4
  // the host's router reported through UPnP. Either way the challenge below proves the host is really there.
  let hostIp = clientIp;
  if (!isIPv4(clientIp)) {
    if (!reg.ipv4) return error("your request came over IPv6; send your public IPv4 address in ipv4", 400);
    hostIp = reg.ipv4;
  }
  if (isPrivateIPv4(hostIp) && env.DEV_ALLOW_PRIVATE !== "1") return error(`${hostIp} is not a public address`, 400);

  const headers = { "X-Client-IP": clientIp, "X-Host-IP": hostIp };
  const stub = lobby(env);
  // Rate limits, bans and caps first, so a refused host costs no socket.
  const pre = await stub.fetch("https://lobby/internal/precheck", { method: "POST", headers });
  if (!pre.ok) return pre;

  if (env.VERIFY !== "off") {
    const r = await verifyHost(hostIp, reg.port, await deriveChallengeKey(reg.token));
    if (!r.ok) {
      // The reason (refused / timeout / wrong answer) only for the host's own address: for any other address it
      // would turn the lobby into a port scanner.
      const message = hostIp === clientIp
        ? `the lobby could not reach TCP port ${reg.port} at ${hostIp} (${r.reason})`
        : `the lobby could not verify the host at ${hostIp}:${reg.port}`;
      return json({ error: message, ip: hostIp, port: reg.port }, 403);
    }
  }

  return stub.fetch("https://lobby/internal/register", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(reg),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/v1") {
      return json({ service: "h7-lobby", api: API_VERSION, docs: "https://github.com/Whaileee/H7Lobby#api" });
    }
    if (!url.pathname.startsWith("/v1/")) return error("not found", 404);

    // Never trust a client-supplied X-Client-IP: replace it with what Cloudflare saw.
    const clientIp = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
    const path = url.pathname.replace(/\/+$/, "");
    if (request.method === "POST" && path === "/v1/games") return register(request, env, clientIp);
    if (request.method === "POST" && path === "/v1/reports") return report(request, env, clientIp);
    if (path === "/v1/admin/reports" || path.startsWith("/v1/admin/reports/")) {
      return reports(env).fetch(new Request(request)); // admin token checked there; no client IP needed
    }

    const headers = new Headers(request.headers);
    headers.set("X-Client-IP", clientIp);
    headers.delete("X-Host-IP");
    return lobby(env).fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
