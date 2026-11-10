/**
 * Einstieg des Cloudflare-Workers: die von OpenNext erzeugte Anwendung plus
 * der Live-Kanal `/api/live` (WebSocket zum Durable Object `LiveStatus`).
 */
// @ts-expect-error Wird erst von `opennextjs-cloudflare build` erzeugt.
import { default as handler } from "../.open-next/worker.js";

export { LiveStatus } from "./live-status";

type Env = {
  LIVE_STATUS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
};

const worker = {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    if (new URL(request.url).pathname === "/api/live") {
      const stub = env.LIVE_STATUS.get(env.LIVE_STATUS.idFromName("status"));
      return stub.fetch(request);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
