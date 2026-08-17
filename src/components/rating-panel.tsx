"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setRatingAction } from "@/app/actions/recordings";
import { formatDateTimeWithSeconds } from "@/lib/time";
import type { Rating } from "@/lib/types";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function RatingPanel({
  recordingId,
  ratings,
  currentEmail,
  average,
}: {
  recordingId: string;
  ratings: Rating[];
  currentEmail: string;
  average: number | null;
}) {
  const router = useRouter();
  const own = ratings.find((rating) => rating.authorEmail === currentEmail) ?? null;
  const [pending, startTransition] = useTransition();
  const [busyScore, setBusyScore] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  function choose(score: number) {
    if (pending) return;
    setBusyScore(score);
    startTransition(async () => {
      const result = await setRatingAction(recordingId, score);
      setFeedback(result);
      setBusyScore(null);
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ink">Bewertung</h2>
        <p className="text-[12px] text-ink-soft">
          Durchschnitt:{" "}
          <strong className="text-[14px] text-ink">
            {average === null
              ? "–"
              : average.toLocaleString("de-CH", {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                })}
          </strong>
          {average !== null && <span className="text-ink-faint"> /10 aus {ratings.length}</span>}
        </p>
      </div>

      <p className="mt-2 text-[12px] text-ink-soft">
        {own
          ? `Ihre Bewertung: ${own.score} von 10. Sie können sie jederzeit anpassen.`
          : "Vergeben Sie Ihre persönliche Bewertung von 1 (schwach) bis 10 (ausgezeichnet)."}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {SCORES.map((score) => {
          const active = own?.score === score;
          return (
            <button
              key={score}
              type="button"
              disabled={pending}
              onClick={() => choose(score)}
              aria-pressed={active}
              className={`h-9 w-9 rounded-[4px] border text-[13px] font-semibold transition-colors ${
                active
                  ? "border-petrol bg-petrol text-white"
                  : "border-line-strong bg-surface text-ink hover:border-petrol hover:text-petrol"
              } ${busyScore === score ? "opacity-60" : ""}`}
            >
              {score}
            </button>
          );
        })}
      </div>

      {feedback && (
        <div className={`notice ${feedback.ok ? "notice-ok" : "notice-error"} mt-3`} role="status">
          {feedback.message}
        </div>
      )}

      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-soft">
          Alle Bewertungen
        </h3>
        {ratings.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-soft">Diese Aufnahme wurde noch nicht bewertet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {ratings.map((rating) => (
              <li
                key={rating._id}
                className="flex items-baseline justify-between gap-3 text-[12.5px]"
              >
                <span className="text-ink">
                  {rating.authorName}
                  {rating.authorEmail === currentEmail && (
                    <span className="ml-1.5 badge bg-petrol-soft text-petrol">Sie</span>
                  )}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="text-[11px] text-ink-faint">
                    {formatDateTimeWithSeconds(rating.updatedAt)}
                  </span>
                  <strong className="w-10 text-right text-[13px] text-ink">{rating.score}/10</strong>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
