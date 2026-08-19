"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  loginAction,
  registerAction,
  requestResetAction,
  resetPasswordAction,
} from "@/app/actions/auth";
import { emptyAuthState, type AuthState } from "@/lib/auth-state";

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

const NOTICE_ID = "auth-hinweis";

/** Markiert das E-Mail-Feld, wenn sich der Validierungsfehler darauf bezieht. */
function invalidEmail(state: AuthState) {
  const invalid = state.status === "fehler" && state.field === "email";
  return {
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? NOTICE_ID : undefined,
  } as const;
}

function StateNotice({ state }: { state: AuthState }) {
  if (state.status === "leer" || !state.message) return null;
  const isError = state.status === "fehler";
  return (
    <div id={NOTICE_ID} className={`notice ${isError ? "notice-error" : "notice-ok"} mb-4`} role="alert">
      <p>{state.message}</p>
      {state.verifyLink && (
        <p className="mt-2 border-t border-current/20 pt-2 text-[12px]">
          Die E-Mail konnte nicht zugestellt werden. Der Bestätigungslink wird deshalb direkt
          angezeigt:{" "}
          <Link href={state.verifyLink} className="font-semibold underline underline-offset-2">
            Link jetzt öffnen
          </Link>
        </p>
      )}
    </div>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, emptyAuthState);
  return (
    <form action={formAction} className="space-y-4">
      <StateNotice state={state} />
      <div>
        <label className="label" htmlFor="email">
          E-Mail-Adresse
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.email}
          required
          className="field"
          placeholder="vorname.nachname@immotrustag.ch"
          {...invalidEmail(state)}
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Passwort
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="field"
        />
      </div>
      <SubmitButton label="Anmelden" pendingLabel="Anmeldung läuft …" />
    </form>
  );
}

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, emptyAuthState);
  return (
    <form action={formAction} className="space-y-4">
      <StateNotice state={state} />
      <div>
        <label className="label" htmlFor="name">
          Vor- und Nachname
        </label>
        <input
          id="name"
          name="name"
          type="text"
          defaultValue={state.name}
          required
          className="field"
          placeholder="Samir Weber"
        />
      </div>
      <div>
        <label className="label" htmlFor="email">
          E-Mail-Adresse
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.email}
          required
          className="field"
          placeholder="vorname.nachname@immotrustag.ch"
          {...invalidEmail(state)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="password">
            Passwort
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            className="field"
          />
        </div>
        <div>
          <label className="label" htmlFor="passwordRepeat">
            Passwort wiederholen
          </label>
          <input
            id="passwordRepeat"
            name="passwordRepeat"
            type="password"
            autoComplete="new-password"
            required
            className="field"
          />
        </div>
      </div>
      <p className="text-[12px] text-ink-faint">
        Mindestens 10 Zeichen, davon mindestens ein Buchstabe und eine Ziffer.
      </p>
      <SubmitButton label="Konto erstellen" pendingLabel="Konto wird erstellt …" />
    </form>
  );
}

export function RequestResetForm() {
  const [state, formAction] = useActionState(requestResetAction, emptyAuthState);
  return (
    <form action={formAction} className="space-y-4">
      <StateNotice state={state} />
      <div>
        <label className="label" htmlFor="email">
          E-Mail-Adresse
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.email}
          required
          className="field"
          placeholder="vorname.nachname@immotrustag.ch"
          {...invalidEmail(state)}
        />
      </div>
      <SubmitButton label="Link zum Zurücksetzen anfordern" pendingLabel="Wird angefordert …" />
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(resetPasswordAction, emptyAuthState);
  return (
    <form action={formAction} className="space-y-4">
      <StateNotice state={state} />
      <input type="hidden" name="token" value={token} />
      {state.status === "erfolg" ? (
        <Link href="/anmelden" className="btn btn-primary w-full">
          Zur Anmeldung
        </Link>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="password">
              Neues Passwort
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              className="field"
            />
          </div>
          <div>
            <label className="label" htmlFor="passwordRepeat">
              Neues Passwort wiederholen
            </label>
            <input
              id="passwordRepeat"
              name="passwordRepeat"
              type="password"
              autoComplete="new-password"
              required
              className="field"
            />
          </div>
          <SubmitButton label="Passwort speichern" pendingLabel="Wird gespeichert …" />
        </>
      )}
    </form>
  );
}
