import "server-only";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { Collections, insertOne } from "./db";
import { createToken } from "./auth";
import { sendMail, type MailDelivery } from "./mailer";

/**
 * Erzeugt Bestätigungs- und Reset-Links, verschickt sie und hält den Versand im
 * Postausgang fest. Einzige Stelle, an der solche Token entstehen – die
 * Anmelde-Aktionen und das Admin-Dashboard greifen beide hierauf zu.
 */

export type AuthMailKind = "bestaetigung" | "passwort_reset";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export type IssuedAuthLink = {
  /** Anwendungsinterner Pfad inklusive Token. */
  path: string;
  /** Vollständige URL für die E-Mail; fällt auf den Pfad zurück, wenn keine Basis bekannt ist. */
  url: string;
  expiresAt: string;
  delivery: MailDelivery;
};

/**
 * Basis für Links in E-Mails. `APP_BASE_URL` hat Vorrang, sonst wird der Host
 * der laufenden Anfrage verwendet. Der Aufruf erfolgt ausschliesslich aus
 * Server Actions, die ohnehin pro Anfrage laufen – statisch vorgerenderte
 * Seiten bleiben davon unberührt.
 */
async function baseUrl(): Promise<string> {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  try {
    const store = await headers();
    const host = store.get("x-forwarded-host") ?? store.get("host");
    if (!host) return "";
    const proto =
      store.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  } catch {
    return "";
  }
}

export async function issueAuthLink(
  email: string,
  kind: AuthMailKind,
  options: { issuedBy?: string } = {},
): Promise<IssuedAuthLink> {
  const { token, hash } = createToken();
  const ttl = kind === "bestaetigung" ? VERIFY_TTL_MS : RESET_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();

  await insertOne(Collections.tokens, {
    _id: hash,
    email,
    kind,
    expiresAt,
    usedAt: null,
    createdAt: new Date().toISOString(),
  });

  const path = `${kind === "bestaetigung" ? "/bestaetigen" : "/passwort-neu"}?token=${token}`;
  const base = await baseUrl();
  const url = base ? `${base}${path}` : path;
  const subject =
    kind === "bestaetigung" ? "Bitte bestätigen Sie Ihre E-Mail-Adresse" : "Passwort zurücksetzen";

  const delivery = await sendMail({ to: email, subject, ...body(kind, url, expiresAt) });

  await insertOne(Collections.mailOutbox, {
    _id: randomUUID(),
    to: email,
    kind,
    subject,
    link: path,
    createdAt: new Date().toISOString(),
    expiresAt,
    deliveryStatus: delivery.status,
    deliveryProvider: delivery.provider,
    deliveryError: delivery.error,
    issuedBy: options.issuedBy ?? null,
  });

  return { path, url, expiresAt, delivery };
}

function body(kind: AuthMailKind, url: string, expiresAt: string) {
  const gueltig = kind === "bestaetigung" ? "24 Stunden" : "60 Minuten";
  const ablauf = new Date(expiresAt).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    dateStyle: "short",
    timeStyle: "short",
  });
  const einleitung =
    kind === "bestaetigung"
      ? "Sie haben ein Konto für die Gesprächsaufzeichnungen der Immotrust AG angelegt. Bitte bestätigen Sie Ihre E-Mail-Adresse:"
      : "Für Ihr Konto bei den Gesprächsaufzeichnungen der Immotrust AG wurde ein neues Passwort angefordert. Über den folgenden Link setzen Sie es:";
  const aktion = kind === "bestaetigung" ? "E-Mail-Adresse bestätigen" : "Neues Passwort setzen";
  const schluss =
    kind === "bestaetigung"
      ? "Haben Sie kein Konto angelegt, können Sie diese Nachricht ignorieren."
      : "Haben Sie kein neues Passwort angefordert, können Sie diese Nachricht ignorieren. Ihr bisheriges Passwort bleibt dann unverändert gültig.";

  const text = [
    "Guten Tag",
    "",
    einleitung,
    "",
    url,
    "",
    `Der Link ist ${gueltig} gültig (bis ${ablauf} Uhr) und kann einmal verwendet werden.`,
    schluss,
    "",
    "Freundliche Grüsse",
    "Immotrust AG",
  ].join("\n");

  const html = `<!doctype html><html lang="de"><body style="margin:0;background:#f5f5f4;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:6px">
<tr><td style="padding:28px">
<p style="margin:0 0 16px;font-size:14px;line-height:1.6">Guten Tag</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.6">${escapeHtml(einleitung)}</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f5f6b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:14px;font-weight:600">${aktion}</a></p>
<p style="margin:0 0 20px;font-size:12px;line-height:1.6;color:#57534e;word-break:break-all">${escapeHtml(url)}</p>
<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#57534e">Der Link ist ${gueltig} gültig (bis ${escapeHtml(ablauf)} Uhr) und kann einmal verwendet werden.</p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#57534e">${escapeHtml(schluss)}</p>
</td></tr></table>
</body></html>`;

  return { text, html };
}

/** Testnachricht des Admin-Dashboards, damit der Versand ohne Konto prüfbar ist. */
export async function sendTestMail(to: string): Promise<MailDelivery> {
  const zeit = new Date().toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    dateStyle: "short",
    timeStyle: "medium",
  });
  return sendMail({
    to,
    subject: "Testnachricht der Gesprächsaufzeichnungen",
    text: [
      "Guten Tag",
      "",
      `Diese Testnachricht wurde am ${zeit} Uhr aus dem Admin-Dashboard der Gesprächsaufzeichnungen ausgelöst.`,
      "Kommt sie an, funktionieren auch Bestätigungs- und Reset-Mails.",
      "",
      "Freundliche Grüsse",
      "Immotrust AG",
    ].join("\n"),
    html: `<!doctype html><html lang="de"><body style="margin:0;background:#f5f5f4;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:6px">
<tr><td style="padding:28px">
<p style="margin:0 0 16px;font-size:14px;line-height:1.6">Guten Tag</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6">Diese Testnachricht wurde am ${escapeHtml(zeit)} Uhr aus dem Admin-Dashboard der Gesprächsaufzeichnungen ausgelöst.</p>
<p style="margin:0;font-size:14px;line-height:1.6">Kommt sie an, funktionieren auch Bestätigungs- und Reset-Mails.</p>
</td></tr></table>
</body></html>`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
