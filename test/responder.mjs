// Reference implementation of the host side of the lobby's challenge (src/verify.ts), for end-to-end tests.
//
//   node test/responder.mjs serve <port> <token>        answer challenges like a host's game would
//   node test/responder.mjs client <host> <port> <token> send one challenge to a responder, print ok / the error
//   node test/responder.mjs register <lobby> <port>      start a responder with a fresh token and register a game
//                                                         at <lobby> (e.g. http://127.0.0.1:8787), print the result
import net from "node:net";
import { createHmac, randomBytes } from "node:crypto";

const hmac = (key, msg) => createHmac("sha256", key).update(msg).digest("hex");
const challengeKey = (token) => hmac(token, "H7LOBBY challenge key");
const LINE = /^H7LOBBY 1 [0-9a-f]{32}\n$/;

function serve(port, token) {
  const ckey = challengeKey(token);
  const server = net.createServer((sock) => {
    sock.setTimeout(2000, () => sock.destroy());
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.length < 43) return;
      if (buf.length === 43 && LINE.test(buf)) sock.end(hmac(ckey, buf.slice(10, 42)) + "\n");
      else sock.destroy();
      console.log(`challenge from ${sock.remoteAddress}: ${buf.length === 43 && LINE.test(buf) ? "answered" : "rejected"}`);
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(port, "0.0.0.0", () => resolve(server)));
}

function client(host, port, token) {
  const nonce = randomBytes(16).toString("hex");
  const expected = hmac(challengeKey(token), nonce) + "\n";
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let got = "";
    sock.setTimeout(3000, () => { sock.destroy(); resolve("timeout"); });
    sock.on("connect", () => sock.write(`H7LOBBY 1 ${nonce}\n`));
    sock.on("data", (d) => { got += d.toString("latin1"); });
    sock.on("close", () => resolve(got === expected ? "ok" : got.length < 65 ? "closed early" : "wrong answer"));
    sock.on("error", (e) => resolve(e.code === "ECONNREFUSED" ? "connection refused" : e.message));
  });
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "serve") {
  await serve(Number(args[0]), args[1]);
  console.log(`responding on TCP ${args[0]}`);
} else if (cmd === "client") {
  const r = await client(args[0], Number(args[1]), args[2]);
  console.log(r);
  process.exit(r === "ok" ? 0 : 1);
} else if (cmd === "register") {
  const [lobby, port] = [args[0].replace(/\/+$/, ""), Number(args[1])];
  const token = randomBytes(32).toString("hex");
  const server = await serve(port, token);
  const res = await fetch(`${lobby}/v1/games`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "responder.mjs", type: "duel", map: "CM_Desert_Canyon_2", slots: 2, port,
      game_version: "2.2.1", engine_version: "test", token }),
  });
  console.log(res.status, await res.text());
  server.close();
  process.exit(res.status === 201 ? 0 : 1);
} else {
  console.error("usage: node test/responder.mjs serve <port> <token> | client <host> <port> <token> | register <lobby> <port>");
  process.exit(2);
}
