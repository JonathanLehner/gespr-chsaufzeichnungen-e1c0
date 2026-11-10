/**
 * Live-Stand der Transkription für geöffnete Seiten.
 *
 * Ein Durable Object (eine Instanz je Umgebung) hält die WebSockets der
 * angemeldeten Browser mit Hibernation (`ctx.acceptWebSocket`). Solange
 * mindestens ein Browser verbunden ist, liest ein Alarm alle 3 s den
 * Versionsstempel `settings/status_version`, den der Transkriptionsdienst
 * und die Anwendung bei jeder Änderung an Status, Fortschritt oder
 * Lebenszeichen erhöhen, und meldet eine neue Version an alle Browser. Die
 * Browser holen daraufhin den Stand ihrer Aufnahmen über eine Server Action.
 *
 * Über die Verbindung geht nur die Versionsnummer, keine Daten. Ohne Browser
 * schliesst der nächste Alarm (spätestens nach 3 s) die Datenbankverbindung
 * und plant keinen weiteren.
 */
import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import { STATUS_VERSION_COLLECTION, STATUS_VERSION_ID } from "../transcriber/shared/queue";

const TICK_MS = 3000;
/** Gleicher Name wie `SESSION_COOKIE` in `src/lib/auth.ts`. */
const SESSION_COOKIE = "gaz_sitzung";

type Env = { MONGODB_URI?: string };
type Doc = { _id: string; [field: string]: unknown };

export class LiveStatus extends DurableObject<Env> {
  private client: Promise<MongoClient> | null = null;
  private version: number | null = null;

  private async collection(name: string) {
    const uri = this.env.MONGODB_URI ?? process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI ist nicht gesetzt.");
    this.client ??= new MongoClient(uri, { maxPoolSize: 2 }).connect();
    try {
      return (await this.client).db().collection<Doc>(name);
    } catch (error) {
      this.client = null;
      throw error;
    }
  }

  private async closeDb(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await (await client).close().catch(() => undefined);
  }

  private async readVersion(): Promise<number> {
    const doc = await (await this.collection(STATUS_VERSION_COLLECTION)).findOne({ _id: STATUS_VERSION_ID });
    return typeof doc?.value === "number" ? doc.value : 0;
  }

  /** Dieselbe Prüfung wie `getCurrentUser`: gültige, nicht abgelaufene Sitzung eines bestätigten Kontos. */
  private async signedIn(request: Request): Promise<boolean> {
    const cookie = request.headers.get("cookie") ?? "";
    const token = cookie
      .split(/;\s*/)
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (!token) return false;
    const hash = createHash("sha256").update(decodeURIComponent(token)).digest("hex");
    const session = await (await this.collection("sessions")).findOne({ _id: hash });
    if (!session || typeof session.expiresAt !== "string" || Date.parse(session.expiresAt) < Date.now()) {
      return false;
    }
    const user = await (await this.collection("users")).findOne({ _id: String(session.userId) });
    return !!user?.emailVerified;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erwartet.", { status: 426 });
    }
    // Der nächste Alarm schliesst die Datenbankverbindung, falls kein Browser verbunden bleibt.
    await this.ensureAlarm();
    let allowed = false;
    try {
      allowed = await this.signedIn(request);
    } catch {
      return new Response("Nicht verfügbar.", { status: 503 });
    }
    if (!allowed) return new Response("Nicht angemeldet.", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    try {
      this.version = await this.readVersion();
      server.send(JSON.stringify({ v: this.version }));
    } catch {
      // Der nächste Alarm versucht es erneut.
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      await this.closeDb();
      return;
    }
    try {
      const version = await this.readVersion();
      if (version !== this.version) {
        this.version = version;
        const message = JSON.stringify({ v: version });
        for (const socket of sockets) {
          try {
            socket.send(message);
          } catch {
            // Getrennte Verbindung; wird mit webSocketClose entfernt.
          }
        }
      }
    } catch {
      // Verbindung neu aufbauen beim nächsten Alarm.
      await this.closeDb();
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") socket.send("pong");
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "Beendet");
    } catch {
      // bereits geschlossen
    }
    // Ohne verbundene Browser schliesst der nächste Alarm die Datenbankverbindung.
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011);
  }
}
