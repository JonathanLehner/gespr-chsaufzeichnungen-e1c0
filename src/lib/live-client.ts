/**
 * Eine gemeinsame WebSocket-Verbindung zu `/api/live` für alle Komponenten
 * einer Seite. Der Server meldet über sie nur die Versionsnummer des
 * Transkriptionsstands; jede Meldung ruft die angemeldeten Rückrufe auf. Die
 * Verbindung besteht nur, solange mindestens ein Rückruf angemeldet ist.
 */

type Listener = (version: number) => void;
type StateListener = (state: LiveState) => void;
export type LiveState = "verbindet" | "verbunden" | "getrennt";

const listeners = new Set<Listener>();
const stateListeners = new Set<StateListener>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepAlive: ReturnType<typeof setInterval> | null = null;
let failures = 0;
let state: LiveState = "getrennt";

function setState(next: LiveState) {
  state = next;
  for (const listener of stateListeners) listener(next);
}

function connect() {
  if (socket || listeners.size === 0) return;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`;
  setState("verbindet");
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    failures = 0;
    setState("verbunden");
    // Hält die Verbindung über Proxys hinweg offen; der Server antwortet ohne Datenbankzugriff.
    keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 45_000);
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    try {
      const { v } = JSON.parse(event.data) as { v?: number };
      if (typeof v === "number") for (const listener of [...listeners]) listener(v);
    } catch {
      // unbekannte Nachricht
    }
  };
  ws.onclose = () => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
    socket = null;
    setState("getrennt");
    if (listeners.size === 0) return;
    // Neu verbinden mit wachsender Pause (2 s bis 60 s).
    failures += 1;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };
}

function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const ws = socket;
  socket = null;
  ws?.close(1000);
}

/** Meldet einen Rückruf an; liefert die Abmeldung. */
export function subscribeLive(listener: Listener, onState?: StateListener): () => void {
  listeners.add(listener);
  if (onState) {
    stateListeners.add(onState);
    onState(state);
  }
  connect();
  return () => {
    listeners.delete(listener);
    if (onState) stateListeners.delete(onState);
    if (listeners.size === 0) disconnect();
  };
}

/** Wiederholte Verbindungsfehler: Die Anzeige weist dann auf Neuladen hin. */
export function liveFailures(): number {
  return failures;
}
