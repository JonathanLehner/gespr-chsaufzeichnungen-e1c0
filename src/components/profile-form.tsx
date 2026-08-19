"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import { updateNameAction } from "@/app/actions/profile";
import { NAME_MAX_LENGTH } from "@/lib/profile-name";
import { emptyProfileState } from "@/lib/profile-state";

function SaveButton() {
  // `useFormStatus` sperrt die Schaltfläche unmittelbar mit dem Absenden; ein
  // zweiter Klick löst dadurch keinen weiteren Serveraufruf aus.
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending} aria-busy={pending}>
      {pending ? "Wird gespeichert …" : "Namen speichern"}
    </button>
  );
}

export function ProfileNameForm({ currentName }: { currentName: string }) {
  const [state, formAction] = useActionState(updateNameAction, emptyProfileState);
  const fieldId = useId();
  const noticeId = `${fieldId}-hinweis`;
  const invalid = state.status === "fehler";

  return (
    <form action={formAction} className="mt-4 space-y-3">
      {state.status !== "leer" && state.message && (
        <div
          id={noticeId}
          role="alert"
          className={`notice ${invalid ? "notice-error" : "notice-ok"}`}
        >
          {state.message}
        </div>
      )}

      <div>
        <label className="label" htmlFor={fieldId}>
          Vor- und Nachname
        </label>
        <input
          id={fieldId}
          name="name"
          type="text"
          required
          maxLength={NAME_MAX_LENGTH}
          autoComplete="name"
          className="field max-w-sm"
          defaultValue={state.status === "leer" ? currentName : state.name}
          placeholder="Samir Weber"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid && state.message ? noticeId : undefined}
        />
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
          So erscheinen Sie im Kopfbereich sowie an Ihren Kommentaren, Bewertungen und
          hochgeladenen Aufnahmen. Bereits vorhandene Einträge werden mitgeändert.
        </p>
      </div>

      <SaveButton />
    </form>
  );
}
