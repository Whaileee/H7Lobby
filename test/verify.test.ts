import { describe, expect, it } from "vitest";
import { challengeLine, deriveChallengeKey, expectedResponse, newNonce, timingSafeEqualStr } from "../src/verify";
import { block24, inCidr, parseCidr, rateKey, toBytes } from "../src/ipaddr";

// Pinned vector: the engine's responder (H7ModEngine tests/offline/net.lua) checks the same values.
const TOKEN = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const CKEY = "00f01b980cb2a9a08e109cfe39e64298fb77586162ba8ea27efb66ec34edc3cc";
const NONCE = "0123456789abcdef0123456789abcdef";
const REPLY = "5794bf2e5e14ea5f4f7eeca473024143a18e94fa4dd32d5274dd6219a3720350";

describe("challenge protocol", () => {
  it("derives the challenge key and the reply", async () => {
    expect(await deriveChallengeKey(TOKEN)).toBe(CKEY);
    expect(await expectedResponse(CKEY, NONCE)).toBe(REPLY);
  });

  it("has fixed-size messages", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(nonce);
    expect(challengeLine(nonce)).toHaveLength(43);
    expect(REPLY.length + 1).toBe(65);
  });

  it("compares in constant time", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("ipaddr", () => {
  it("parses IPv6 forms", () => {
    expect(toBytes("::1")).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
    expect(toBytes("::ffff:1.2.3.4")).toEqual(toBytes("1.2.3.4"));
    expect(toBytes("2001:db8::")?.slice(0, 4)).toEqual(new Uint8Array([0x20, 0x01, 0x0d, 0xb8]));
    expect(toBytes("1:2:3:4:5:6:7:8")?.[15]).toBe(8);
    for (const bad of ["1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "::ffff:999.1.1.1", "hello", "1.2.3"]) expect(toBytes(bad)).toBeNull();
  });

  it("keys IPv6 by /48 and IPv4 by address", () => {
    expect(rateKey("2001:db8:1:2::5")).toBe(rateKey("2001:db8:1:ffff::9"));
    expect(rateKey("2001:db8:1::")).not.toBe(rateKey("2001:db8:2::"));
    expect(rateKey("198.51.100.7")).toBe("198.51.100.7");
    expect(block24("198.51.100.7")).toBe("198.51.100.0/24");
  });

  it("matches CIDR ranges", () => {
    const r = parseCidr("198.51.100.77/24")!;
    expect(r.text).toBe("198.51.100.0/24");
    expect(inCidr("198.51.100.1", r)).toBe(true);
    expect(inCidr("198.51.101.1", r)).toBe(false);
    expect(inCidr("2001:db8::1", r)).toBe(false);
    const v6 = parseCidr("2001:db8:aa::/48")!;
    expect(inCidr("2001:db8:aa:5::1", v6)).toBe(true);
    expect(inCidr("2001:db8:ab::1", v6)).toBe(false);
    expect(inCidr("1.2.3.4", parseCidr("1.2.3.4")!)).toBe(true);
    expect(parseCidr("1.2.3.4/33")).toBeNull();
    expect(parseCidr("1.2.3.4/x")).toBeNull();
  });
});

describe("entry module", () => {
  it("exports only handlers and classes (workerd refuses to start otherwise)", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod).sort()).toEqual(["Lobby", "Reports", "default"]);
  });
});
