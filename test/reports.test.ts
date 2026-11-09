import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_REPORTS_PER_MINUTE, MAX_REPORTS_PER_SESSION } from "../src/reports";
import { MAX_REPORT_LOG } from "../src/validate";

const BASE = "https://lobby.test";
const ADMIN = "test-admin-token"; // vitest.config.ts

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

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

const report = (over: Record<string, unknown> = {}) => ({
  session: hex(16),
  game: "ABC234",
  role: "client",
  player: 1,
  trigger: "LATE,OOS",
  uac: 57,
  map: "CM_Desert_Canyon_2",
  simturns: false,
  game_version: "2.2.1",
  engine_version: "0.3.0",
  mods: [],
  edition: "base",
  log: "# mpsync role=client player=1\n     1.000 u=57 r=10 LATE uac=56 cmd=UC_MOVE\n  | hero 77 p0 Ivan @4,9\n",
  ...over,
});

let nextIp = 1;
const freshIp = () => `198.51.100.${nextIp++}`; // the per-minute limits count per caller

async function send(over: Record<string, unknown> = {}, ip = freshIp()) {
  return call("/v1/reports", { method: "POST", json: report(over), ip });
}

describe("desync reports", () => {
  it("stores a report and lists it for the admin, without the log or the caller's address", async () => {
    const res = await send({ game: "xyz789" }, "203.0.113.200");
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);

    const listRes = await call("/v1/admin/reports?game=XYZ789", { token: ADMIN });
    expect(listRes.status).toBe(200);
    const { reports } = (await listRes.json()) as { reports: Array<Record<string, unknown>> };
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id, game: "XYZ789", role: "client", trigger: "LATE,OOS", uac: 57, game_version: "2.2.1" });
    expect(reports[0]).not.toHaveProperty("log");
    expect(JSON.stringify(reports[0])).not.toContain("203.0.113.200");

    const one = (await (await call(`/v1/admin/reports/${id}`, { token: ADMIN })).json()) as Record<string, unknown>;
    expect(one.log).toContain("LATE uac=56");
    expect(JSON.stringify(one)).not.toContain("203.0.113.200");
  });

  it("keeps the admin routes behind the admin token", async () => {
    expect((await call("/v1/admin/reports")).status).toBe(403);
    expect((await call("/v1/admin/reports", { token: "wrong" })).status).toBe(403);
    expect((await call("/v1/admin/reports/ABCDEFGHJK", { token: "wrong" })).status).toBe(403);
  });

  it("deletes a report", async () => {
    const { id } = (await (await send()).json()) as { id: string };
    expect((await call(`/v1/admin/reports/${id}`, { method: "DELETE", token: ADMIN })).status).toBe(204);
    expect((await call(`/v1/admin/reports/${id}`, { token: ADMIN })).status).toBe(404);
    expect((await call(`/v1/admin/reports/${id}`, { method: "DELETE", token: ADMIN })).status).toBe(404);
  });

  it("filters by session", async () => {
    const session = hex(16);
    await send({ session });
    await send({ session, trigger: "OOS" });
    await send();
    const { reports } = (await (await call(`/v1/admin/reports?session=${session}`, { token: ADMIN })).json()) as {
      reports: Array<{ session: string }>;
    };
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.session === session)).toBe(true);
  });

  it("validates reports", async () => {
    const bad: Array<Record<string, unknown>> = [
      { session: "not-hex" },
      { game: "ab-c" },
      { role: "Host!" },
      { trigger: "oos" },
      { trigger: "" },
      { log: "" },
      { log: 42 },
      { log: "a\u0000b" },
      { log: "x".repeat(MAX_REPORT_LOG + 1) },
      { player: 9 },
      { simturns: "yes" },
      { edition: "gold" },
      { game_version: undefined },
      { mods: [{ version: "1" }] },
    ];
    for (const over of bad) {
      const res = await send(over);
      expect(res.status, JSON.stringify(over).slice(0, 80)).toBe(400);
    }
    expect((await call("/v1/reports", { method: "POST", body: "{nope", ip: freshIp() })).status).toBe(400);
    // Tabs, line breaks and an empty mod list sent as {} by Lua are fine; a LAN game has no lobby id.
    expect((await send({ log: "a\tb\r\nc\n", mods: {}, game: undefined })).status).toBe(201);
  });

  it("refuses bodies over the limit before they reach storage", async () => {
    const res = await send({ log: "x".repeat(MAX_REPORT_LOG * 2) });
    expect(res.status).toBe(413);
  });

  it("caps reports per game session", async () => {
    const session = hex(16);
    for (let i = 0; i < MAX_REPORTS_PER_SESSION; i++) expect((await send({ session })).status).toBe(201);
    expect((await send({ session })).status).toBe(429);
  });

  it("limits reports per caller and minute", async () => {
    const ip = "203.0.113.210";
    for (let i = 0; i < MAX_REPORTS_PER_MINUTE; i++) expect((await send({}, ip)).status).toBe(201);
    expect((await send({}, ip)).status).toBe(429);
    expect((await send({}, "203.0.113.211")).status).toBe(201);
  });
});
