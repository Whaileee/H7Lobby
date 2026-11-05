// IP address helpers: validation, the keys used for limits, and CIDR matching for bans.

export function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

// Addresses another player on the internet can never reach (private, loopback, link-local, CGNAT, multicast, ...).
export function isPrivateIPv4(s: string): boolean {
  const [a, b] = s.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// 16 bytes (IPv4 as ::ffff:a.b.c.d), or null if `s` is not an address.
export function toBytes(s: string): Uint8Array | null {
  if (isIPv4(s)) return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...s.split(".").map(Number)]);
  if (!s.includes(":") || s.length > 45) return null;
  let text = s.toLowerCase();
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) { // ::ffff:1.2.3.4
    const v4 = text.slice(lastColon + 1);
    if (!isIPv4(v4)) return null;
    const p = v4.split(".").map(Number);
    tail.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
    text = text.slice(0, lastColon + 1); // "::ffff:" / "1:2:3:4:5:6:" / "::"
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const group = (h: string) => (h === "" ? [] : h.split(":"));
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  const words: number[] = [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  words.push(...head.map((g) => parseInt(g, 16)));
  if (halves.length === 2) for (let i = given; i < 8; i++) words.push(0);
  words.push(...rest.map((g) => parseInt(g, 16)), ...tail);
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[i * 2] = w >> 8; out[i * 2 + 1] = w & 0xff; });
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The key limits count against: an IPv4 address as is, an IPv6 address by its /48 (what one customer of a
// tunnel or ISP typically gets, so rotating addresses inside it doesn't help).
export function rateKey(ip: string): string {
  if (isIPv4(ip)) return ip;
  const b = toBytes(ip);
  return b ? `v6:${hex(b.slice(0, 6))}::/48` : ip;
}

// The /24 an IPv4 address belongs to ("" for anything else).
export function block24(ip: string): string {
  return isIPv4(ip) ? ip.split(".").slice(0, 3).join(".") + ".0/24" : "";
}

export interface Cidr {
  text: string;     // normalised, e.g. "198.51.100.0/24" or "2001:db8::/32" as given
  bytes: Uint8Array;
  bits: number;     // prefix length on the 16-byte form
  v4: boolean;
  prefix: number;   // as written (0..32 for IPv4, 0..128 for IPv6)
}

export function parseCidr(s: string): Cidr | null {
  const [addr, len, extra] = s.trim().split("/");
  if (extra !== undefined) return null;
  const bytes = toBytes(addr);
  if (!bytes) return null;
  const v4 = isIPv4(addr);
  const max = v4 ? 32 : 128;
  const prefix = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!(prefix >= 0 && prefix <= max)) return null;
  const bits = v4 ? prefix + 96 : prefix;
  // Zero the host part so equal ranges get equal keys.
  const masked = bytes.slice();
  for (let i = 0; i < 16; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    masked[i] &= keep === 8 ? 0xff : (0xff << (8 - keep)) & 0xff;
  }
  const text = v4 ? `${Array.from(masked.slice(12)).join(".")}/${prefix}` : `${addr.toLowerCase()}/${prefix}`;
  return { text, bytes: masked, bits, v4, prefix };
}

export function inCidr(ip: string, c: Cidr): boolean {
  const b = toBytes(ip);
  if (!b) return false;
  for (let i = 0; i < 16; i++) {
    const keep = Math.max(0, Math.min(8, c.bits - i * 8));
    if (keep === 0) return true;
    const mask = keep === 8 ? 0xff : (0xff << (8 - keep)) & 0xff;
    if ((b[i] & mask) !== c.bytes[i]) return false;
  }
  return true;
}
