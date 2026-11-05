// Entry Worker: answers / and forwards /v1/* to the single Lobby Durable Object, passing the caller's IP.
import { Lobby } from "./lobby";

export { Lobby };

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  PROBE: string;
}

export const API_VERSION = 1;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/v1") {
      return Response.json({
        service: "h7-lobby",
        api: API_VERSION,
        docs: "https://github.com/Whaileee/H7Lobby#api",
      });
    }
    if (!url.pathname.startsWith("/v1/")) return Response.json({ error: "not found" }, { status: 404 });

    // Never trust a client-supplied X-Client-IP: replace it with what Cloudflare saw.
    const headers = new Headers(request.headers);
    headers.set("X-Client-IP", request.headers.get("CF-Connecting-IP") ?? "127.0.0.1");
    const forwarded = new Request(request, { headers });
    const stub = env.LOBBY.get(env.LOBBY.idFromName("global"));
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
