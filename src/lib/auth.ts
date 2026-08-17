import "server-only";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { Collections, findById, insertOne, insertUnique, updateOne, deleteById, deleteMany } from "./db";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";
import type { SessionUser, User } from "./types";

export { hashPassword, passwordProblem, verifyPassword };

export const SUPERUSER_EMAIL = "jonathanslehner@gmail.com";
export const ALLOWED_DOMAIN = "immotrustag.ch";
export const SESSION_COOKIE = "gaz_sitzung";
const SESSION_DAYS = 30;

/* ------------------------------------------------------ E-Mail-Zulassung */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isSuperuser(email: string): boolean {
  return normalizeEmail(email) === SUPERUSER_EMAIL;
}

export function emailAllowed(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return false;
  if (normalized === SUPERUSER_EMAIL) return true;
  const [local, domain] = normalized.split("@");
  return Boolean(local) && domain === ALLOWED_DOMAIN;
}

export const EMAIL_NOT_ALLOWED_MESSAGE =
  `Diese E-Mail-Adresse ist nicht zugelassen. Erlaubt sind ausschliesslich Adressen der Domain ` +
  `@${ALLOWED_DOMAIN} sowie ${SUPERUSER_EMAIL}.`;

/* ----------------------------------------------------------------- Tokens */

export function createToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/* --------------------------------------------------------------- Sitzungen */

export async function createSession(email: string): Promise<void> {
  const { token, hash } = createToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await insertOne(Collections.sessions, {
    _id: hash,
    userId: normalizeEmail(email),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteById(Collections.sessions, sha256(token));
  store.delete(SESSION_COOKIE);
}

export function toSessionUser(user: User): SessionUser {
  const admin = user.role === "admin" || isSuperuser(user.email);
  return { email: user.email, name: user.name, role: admin ? "admin" : "user", isAdmin: admin };
}

/** Liest die aktuelle Sitzung. Gibt `null` zurück, wenn niemand angemeldet ist. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await findById<{ userId: string; expiresAt: string }>(
    Collections.sessions,
    sha256(token),
  );
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await deleteById(Collections.sessions, session._id);
    return null;
  }
  const user = await findById<User>(Collections.users, session.userId);
  if (!user || !user.emailVerified) return null;
  return toSessionUser(user);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("NICHT_ANGEMELDET");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw new Error("KEINE_BERECHTIGUNG");
  return user;
}

/* ------------------------------------------------------------- Benutzerkonto */

export async function createUser(params: {
  email: string;
  name: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(params.email);
  if (!emailAllowed(email)) return { ok: false, error: EMAIL_NOT_ALLOWED_MESSAGE };
  const problem = passwordProblem(params.password);
  if (problem) return { ok: false, error: problem };

  const passwordHash = await hashPassword(params.password);
  const created = await insertUnique(Collections.users, {
    _id: email,
    email,
    name: params.name.trim() || email.split("@")[0],
    role: isSuperuser(email) ? "admin" : "user",
    passwordHash,
    emailVerified: false,
    createdAt: new Date().toISOString(),
  });
  if (!created) {
    return { ok: false, error: "Für diese E-Mail-Adresse besteht bereits ein Konto." };
  }
  return { ok: true };
}

/** Die Rolle des Superusers wird bei jedem Zugriff erzwungen. */
export async function enforceSuperuserRole(user: User): Promise<User> {
  if (isSuperuser(user.email) && user.role !== "admin") {
    await updateOne(Collections.users, { _id: user._id }, { $set: { role: "admin" } });
    return { ...user, role: "admin" };
  }
  return user;
}

export async function invalidateSessionsForUser(email: string): Promise<void> {
  await deleteMany(Collections.sessions, { userId: normalizeEmail(email) });
}
