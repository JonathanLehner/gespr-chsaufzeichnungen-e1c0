"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addCommentAction,
  deleteCommentAction,
  updateCommentAction,
} from "@/app/actions/recordings";
import { formatDateTimeWithSeconds } from "@/lib/time";
import type { Comment } from "@/lib/types";

export function CommentsPanel({
  recordingId,
  comments,
  currentEmail,
}: {
  recordingId: string;
  comments: Comment[];
  currentEmail: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (pending || text.trim().length < 2) return;
    const value = text;
    startTransition(async () => {
      const result = await addCommentAction(recordingId, value);
      setFeedback(result);
      if (result.ok) {
        setText("");
        router.refresh();
      }
    });
  }

  return (
    <section className="card p-4">
      <h2 className="text-[14px] font-semibold text-ink">
        Kommentare <span className="font-normal text-ink-faint">({comments.length})</span>
      </h2>

      <div className="mt-3 space-y-3">
        {comments.length === 0 && (
          <p className="text-[13px] text-ink-soft">
            Noch keine Kommentare. Halten Sie hier Beobachtungen zum Gesprächsverlauf fest.
          </p>
        )}
        {comments.map((comment) => (
          <CommentItem
            key={comment._id}
            comment={comment}
            own={comment.authorEmail === currentEmail}
          />
        ))}
      </div>

      <div className="mt-4 border-t border-line pt-4">
        {feedback && (
          <div className={`notice ${feedback.ok ? "notice-ok" : "notice-error"} mb-3`} role="status">
            {feedback.message}
          </div>
        )}
        <label className="label" htmlFor="kommentar">
          Neuer Kommentar
        </label>
        <textarea
          id="kommentar"
          className="field min-h-[90px] resize-y"
          value={text}
          maxLength={4000}
          onChange={(event) => setText(event.target.value)}
          placeholder="Beobachtung, Rückfrage oder Hinweis zum Gespräch …"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-ink-faint">{text.length}/4000 Zeichen</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || text.trim().length < 2}
            onClick={submit}
          >
            {pending ? "Wird gespeichert …" : "Kommentar speichern"}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Einzelner Kommentar. Bearbeiten und Löschen stehen ausschliesslich der
 * verfassenden Person offen; der Server prüft die Zuordnung erneut. Eine
 * Änderung bleibt am Kommentar sichtbar („bearbeitet am …“), damit die
 * Nachvollziehbarkeit für das Team erhalten bleibt.
 */
function CommentItem({ comment, own }: { comment: Comment; own: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"ansicht" | "bearbeiten" | "loeschen">("ansicht");
  const [draft, setDraft] = useState(comment.text);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startEditing() {
    setDraft(comment.text);
    setError(null);
    setMode("bearbeiten");
  }

  function cancel() {
    setDraft(comment.text);
    setError(null);
    setMode("ansicht");
  }

  function save() {
    if (pending || draft.trim().length < 2) return;
    const value = draft;
    startTransition(async () => {
      const result = await updateCommentAction(comment._id, value);
      if (result.ok) {
        setError(null);
        setMode("ansicht");
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  function remove() {
    if (pending) return;
    startTransition(async () => {
      const result = await deleteCommentAction(comment._id);
      if (result.ok) {
        setError(null);
        setMode("ansicht");
        router.refresh();
      } else {
        setError(result.message);
        setMode("ansicht");
      }
    });
  }

  const fieldId = `kommentar-${comment._id}`;

  return (
    <article className="rounded-[4px] border border-line bg-canvas/60 p-3">
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-semibold text-ink">{comment.authorName}</span>
        {own && <span className="badge bg-petrol-soft text-petrol">Sie</span>}
        <span className="text-[11px] text-ink-faint">
          {formatDateTimeWithSeconds(comment.createdAt)}
        </span>
        {comment.editedAt && (
          <span className="text-[11px] italic text-ink-faint">
            bearbeitet am {formatDateTimeWithSeconds(comment.editedAt)}
          </span>
        )}
      </header>

      {mode === "bearbeiten" ? (
        <div className="mt-2">
          <label className="label" htmlFor={fieldId}>
            Kommentar bearbeiten
          </label>
          <textarea
            id={fieldId}
            className="field min-h-[80px] resize-y"
            value={draft}
            maxLength={4000}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-faint">{draft.length}/4000 Zeichen</span>
            <span className="flex gap-2">
              <button type="button" className="btn btn-ghost" disabled={pending} onClick={cancel}>
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending || draft.trim().length < 2}
                onClick={save}
              >
                {pending ? "Wird gespeichert …" : "Änderung speichern"}
              </button>
            </span>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
          {comment.text}
        </p>
      )}

      {error && (
        <div className="notice notice-error mt-2" role="status">
          {error}
        </div>
      )}

      {own && mode === "ansicht" && (
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={startEditing}>
            Bearbeiten
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={() => {
              setError(null);
              setMode("loeschen");
            }}
          >
            Löschen
          </button>
        </div>
      )}

      {own && mode === "loeschen" && (
        <div className="notice notice-warn mt-2 flex flex-wrap items-center justify-between gap-2">
          <span>Diesen Kommentar endgültig löschen?</span>
          <span className="flex gap-2">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => setMode("ansicht")}
            >
              Abbrechen
            </button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={remove}>
              {pending ? "Wird gelöscht …" : "Endgültig löschen"}
            </button>
          </span>
        </div>
      )}
    </article>
  );
}
