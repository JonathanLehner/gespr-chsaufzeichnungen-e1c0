"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addCommentAction } from "@/app/actions/recordings";
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
          <article key={comment._id} className="rounded-[4px] border border-line bg-canvas/60 p-3">
            <header className="flex flex-wrap items-baseline gap-2">
              <span className="text-[13px] font-semibold text-ink">{comment.authorName}</span>
              {comment.authorEmail === currentEmail && (
                <span className="badge bg-petrol-soft text-petrol">Sie</span>
              )}
              <span className="text-[11px] text-ink-faint">
                {formatDateTimeWithSeconds(comment.createdAt)}
              </span>
            </header>
            <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
              {comment.text}
            </p>
          </article>
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
