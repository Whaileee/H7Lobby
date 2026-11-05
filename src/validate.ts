// Input validation for game registrations and heartbeats. Everything a host sends is untrusted.

export type GameType = "skirmish" | "duel";

export interface ModInfo {
  name: string;
  version: string;
}

// A group of community content packages (from the host's CookedPC folder); version is a content hash.
export interface ContentPack {
  name: string;
  version: string;
  files: number;
}

export type Edition = "base" | "modded";

export interface Registration {
  name: string;
  type: GameType;
  map: string;
  map_info: number;
  slots: number;
  players: number;
  port: number;
  private: boolean;
  game_version: string;
  engine_version: string;
  mods: ModInfo[];
  edition: Edition;
  content: ContentPack[];
  content_fingerprint: string;
  settings: Record<string, string | number | boolean>;
  ipv4?: string;
}

export interface Heartbeat {
  players?: number;
  started?: boolean;
}

export class InvalidInput extends Error {}

const fail = (msg: string): never => {
  throw new InvalidInput(msg);
};

function str(v: unknown, field: string, max: number, required = true): string {
  if (v === undefined || v === null) {
    if (required) fail(`${field} is required`);
    return "";
  }
  if (typeof v !== "string") return fail(`${field} must be a string`);
  // Printable text only; no control characters (they would end up in the game's UI).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) fail(`${field} contains control characters`);
  const t = v.trim();
  if (required && !t) fail(`${field} must not be empty`);
  if (t.length > max) fail(`${field} is longer than ${max} characters`);
  return t;
}

function int(v: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) return fail(`${field} must be an integer`);
  if (v < min || v > max) fail(`${field} must be ${min}..${max}`);
  return v;
}

export function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

// Addresses another player on the internet can never reach.
export function isPrivateIPv4(s: string): boolean {
  const [a, b] = s.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function parseRegistration(body: unknown): Registration {
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const type = str(b.type, "type", 16);
  if (type !== "skirmish" && type !== "duel") fail('type must be "skirmish" or "duel"');
  const slots = int(b.slots, "slots", 2, 8);
  const players = int(b.players, "players", 1, slots, 1);

  const mods: ModInfo[] = [];
  if (b.mods !== undefined) {
    if (!Array.isArray(b.mods)) fail("mods must be an array");
    const list = b.mods as unknown[];
    if (list.length > 64) fail("at most 64 mods");
    for (const m of list) {
      if (typeof m !== "object" || m === null) fail("mods entries must be objects");
      const mm = m as Record<string, unknown>;
      mods.push({ name: str(mm.name, "mods[].name", 64), version: str(mm.version, "mods[].version", 32, false) });
    }
  }

  const content: ContentPack[] = [];
  if (b.content !== undefined) {
    if (!Array.isArray(b.content)) fail("content must be an array");
    const list = b.content as unknown[];
    if (list.length > 128) fail("at most 128 content packs");
    for (const c of list) {
      if (typeof c !== "object" || c === null) fail("content entries must be objects");
      const cc = c as Record<string, unknown>;
      content.push({
        name: str(cc.name, "content[].name", 64),
        version: str(cc.version, "content[].version", 16),
        files: int(cc.files, "content[].files", 0, 100_000, 0),
      });
    }
  }
  const edition = b.edition === undefined ? (content.length ? "modded" : "base") : str(b.edition, "edition", 16);
  if (edition !== "base" && edition !== "modded") fail('edition must be "base" or "modded"');

  const settings: Record<string, string | number | boolean> = {};
  if (b.settings !== undefined) {
    if (typeof b.settings !== "object" || b.settings === null || Array.isArray(b.settings)) fail("settings must be an object");
    const entries = Object.entries(b.settings as Record<string, unknown>);
    if (entries.length > 32) fail("at most 32 settings");
    for (const [k, v] of entries) {
      str(k, "settings key", 32);
      if (typeof v === "string") settings[k] = str(v, `settings.${k}`, 2048, false); // the random map generator string can be long
      else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) settings[k] = v;
      else fail(`settings.${k} must be a string, number or boolean`);
    }
  }

  let ipv4: string | undefined;
  if (b.ipv4 !== undefined) {
    ipv4 = str(b.ipv4, "ipv4", 15);
    if (!isIPv4(ipv4)) fail("ipv4 must be an IPv4 address");
  }

  return {
    name: str(b.name, "name", 40),
    type: type as GameType,
    map: str(b.map, "map", 128),
    map_info: int(b.map_info, "map_info", 0, 1_000_000, 0),
    slots,
    players,
    port: int(b.port, "port", 1024, 65535, 27015),
    private: b.private === undefined ? false : b.private === true ? true : b.private === false ? false : fail("private must be a boolean"),
    game_version: str(b.game_version, "game_version", 32),
    engine_version: str(b.engine_version, "engine_version", 32),
    mods,
    edition: edition as Edition,
    content,
    content_fingerprint: str(b.content_fingerprint, "content_fingerprint", 32, false),
    settings,
    ipv4,
  };
}

export function parseHeartbeat(body: unknown): Heartbeat {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) fail("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const hb: Heartbeat = {};
  if (b.players !== undefined) hb.players = int(b.players, "players", 0, 8);
  if (b.started !== undefined) {
    if (typeof b.started !== "boolean") fail("started must be a boolean");
    hb.started = b.started as boolean;
  }
  return hb;
}
