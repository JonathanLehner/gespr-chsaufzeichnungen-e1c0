"use server";

import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { Collections, findById, insertOne, updateOne } from "@/lib/db";
import {
  EMAIL_NOT_ALLOWED_MESSAGE,
  createSession,
  createToken,
  createUser,
  destroySession,
  emailAllowed,
  enforceSuperuserRole,
  hashPassword,
  invalidateSessionsForUser,
  isSuperuser,
  normalizeEmail,
  passwordProblem,
  sha256,
  verifyPassword,
} from "@/lib/auth";
import type { User } from "@/lib/types";
import type { AuthState } from "@/lib/auth-state";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

type TokenDoc = {
  _id: string;
  email: string;
  kind: "bestaetigung" | "passwort_reset";
  expiresAt: string;
  usedAt: string | null;
};

async function issueToken(
  email: string,
  kind: TokenDoc["kind"],
): Promise<{ link: string; expiresAt: string }> {
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
  const path = kind === "bestaetigung" ? "/bestaetigen" : "/passwort-neu";
  const link = `${path}?token=${token}`;
  await insertOne(Collections.mailOutbox, {
    _id: randomUUID(),
    to: email,
    kind,
    subject:
      kind === "bestaetigung"
        ? "Bitte bestätigen Sie Ihre E-Mail-Adresse"
        : "Passwort zurücksetzen",
    link,
    createdAt: new Date().toISOString(),
    expiresAt,
  });
  return { link, expiresAt };
}

async function consumeToken(
  token: string,
  kind: TokenDoc["kind"],
): Promise<{ ok: true; email: string } | { ok: false; message: string }> {
  if (!token) {
    return { ok: false, message: "Der Link ist unvollständig. Bitte fordern Sie einen neuen an." };
  }
  const doc = await findById<TokenDoc>(Collections.tokens, sha256(token));
  if (!doc || doc.kind !== kind) {
    return {
      ok: false,
      message: "Dieser Link ist ungültig. Möglicherweise wurde er bereits verwendet.",
    };
  }
  if (doc.usedAt) {
    return { ok: false, message: "Dieser Link wurde bereits verwendet. Bitte fordern Sie einen neuen an." };
  }
  if (new Date(doc.expiresAt).getTime() < Date.now()) {
    return {
      ok: false,
      message:
        kind === "bestaetigung"
          ? "Dieser Bestätigungslink ist abgelaufen. Bitte registrieren Sie sich erneut oder fordern Sie einen neuen Link an."
          : "Dieser Reset-Link ist abgelaufen. Bitte fordern Sie einen neuen an.",
    };
  }
  const claimed = await updateOne(
    Collections.tokens,
    { _id: doc._id, usedAt: null },
    { $set: { usedAt: new Date().toISOString() } },
  );
  if (claimed.modified !== 1) {
    return { ok: false, message: "Dieser Link wurde bereits verwendet." };
  }
  return { ok: true, email: doc.email };
}

/* ------------------------------------------------------------ Registrierung */

export async function registerAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const passwordRepeat = String(formData.get("passwordRepeat") ?? "");

  if (!email || !password) {
    return { status: "fehler", message: "Bitte füllen Sie alle Pflichtfelder aus.", email, name };
  }
  if (!emailAllowed(email)) {
    return { status: "fehler", message: EMAIL_NOT_ALLOWED_MESSAGE, email, name, field: "email" };
  }
  if (password !== passwordRepeat) {
    return { status: "fehler", message: "Die beiden Passwörter stimmen nicht überein.", email, name };
  }
  const problem = passwordProblem(password);
  if (problem) return { status: "fehler", message: problem, email, name };

  const result = await createUser({ email, name, password });
  if (!result.ok) {
    const existing = await findById<User>(Collections.users, email);
    if (existing && !existing.emailVerified) {
      const { link } = await issueToken(email, "bestaetigung");
      return {
        status: "erfolg",
        email,
        verifyLink: link,
        message:
          "Für diese Adresse besteht bereits ein unbestätigtes Konto. Wir haben einen neuen Bestätigungslink erzeugt.",
      };
    }
    return { status: "fehler", message: result.error, email, name };
  }

  const { link } = await issueToken(email, "bestaetigung");
  return {
    status: "erfolg",
    email,
    verifyLink: link,
    message: "Konto angelegt. Bitte bestätigen Sie jetzt Ihre E-Mail-Adresse.",
  };
}

/* ---------------------------------------------------------------- Anmeldung */

export async function loginAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { status: "fehler", message: "Bitte E-Mail-Adresse und Passwort eingeben.", email };
  }
  if (!emailAllowed(email)) {
    return { status: "fehler", message: EMAIL_NOT_ALLOWED_MESSAGE, email, field: "email" };
  }

  const user = await findById<User>(Collections.users, email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return {
      status: "fehler",
      message: "E-Mail-Adresse oder Passwort ist nicht korrekt.",
      email,
    };
  }
  if (!user.emailVerified) {
    const { link } = await issueToken(email, "bestaetigung");
    return {
      status: "fehler",
      email,
      verifyLink: link,
      message:
        "Ihre E-Mail-Adresse ist noch nicht bestätigt. Wir haben einen neuen Bestätigungslink erzeugt.",
    };
  }

  await enforceSuperuserRole(user);
  await updateOne(Collections.users, { _id: email }, { $set: { lastLoginAt: new Date().toISOString() } });
  await createSession(email);
  redirect(isSuperuser(email) ? "/aufnahmen" : "/aufnahmen");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/anmelden");
}

/* --------------------------------------------------------------- Bestätigung */

export async function verifyEmailAction(token: string): Promise<AuthState> {
  const result = await consumeToken(token, "bestaetigung");
  if (!result.ok) return { status: "fehler", message: result.message };

  const user = await findById<User>(Collections.users, result.email);
  if (!user) {
    return { status: "fehler", message: "Zu diesem Link besteht kein Konto mehr." };
  }
  await updateOne(
    Collections.users,
    { _id: result.email },
    { $set: { emailVerified: true, role: isSuperuser(result.email) ? "admin" : user.role } },
  );
  return {
    status: "erfolg",
    email: result.email,
    message: "E-Mail-Adresse bestätigt. Sie können sich jetzt anmelden.",
  };
}

/* --------------------------------------------------------- Passwort zurück */

export async function requestResetAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!emailAllowed(email)) {
    return { status: "fehler", message: EMAIL_NOT_ALLOWED_MESSAGE, email, field: "email" };
  }
  const user = await findById<User>(Collections.users, email);
  if (user) {
    // Der Link wandert ausschliesslich in den Postausgang. Er wird bewusst weder
    // zurückgegeben noch angezeigt – auch nicht, wenn kein E-Mail-Versand
    // eingerichtet ist, weil er sonst jeder Person offenstünde, die eine fremde
    // Adresse eintippt.
    await issueToken(email, "passwort_reset");
  }
  // Bewusst identische Antwort für bestehende und unbekannte Adressen.
  return {
    status: "erfolg",
    email,
    message:
      "Falls ein Konto zu dieser Adresse besteht, haben wir einen Link zum Zurücksetzen an diese E-Mail-Adresse geschickt. Er ist 60 Minuten gültig. Aus Sicherheitsgründen wird der Link nie hier angezeigt. Kommt keine E-Mail an, wenden Sie sich bitte an die Administration.",
  };
}

export async function resetPasswordAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const passwordRepeat = String(formData.get("passwordRepeat") ?? "");

  if (password !== passwordRepeat) {
    return { status: "fehler", message: "Die beiden Passwörter stimmen nicht überein." };
  }
  const problem = passwordProblem(password);
  if (problem) return { status: "fehler", message: problem };

  const result = await consumeToken(token, "passwort_reset");
  if (!result.ok) return { status: "fehler", message: result.message };

  const passwordHash = await hashPassword(password);
  await updateOne(
    Collections.users,
    { _id: result.email },
    { $set: { passwordHash, emailVerified: true } },
  );
  await invalidateSessionsForUser(result.email);
  return {
    status: "erfolg",
    email: result.email,
    message: "Passwort geändert. Sie können sich jetzt mit dem neuen Passwort anmelden.",
  };
}
