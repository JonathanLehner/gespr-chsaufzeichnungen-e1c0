import Link from "next/link";
import type { Metadata } from "next";
import { PublicFooter, PublicHeader } from "@/components/brand";
import { IMAGES } from "@/lib/media";
import { DEFAULT_TEMPLATE_EXAMPLE } from "@/lib/filename-template";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Gesprächsaufzeichnungen – Immotrust AG",
  description:
    "Verkaufsgespräche der Immotrust AG zentral ablegen, automatisch transkribieren, durchsuchen, anhören und bewerten.",
};

const features = [
  {
    title: "Sammelupload mit Dateinamensanalyse",
    text: `Mehrere WAV- oder MP3-Dateien gleichzeitig hochladen. Name, Telefonnummer, Zeitpunkt und Anrufnummer werden direkt aus dem Dateinamen gelesen, zum Beispiel aus ${DEFAULT_TEMPLATE_EXAMPLE}.`,
  },
  {
    title: "Automatische Transkription",
    text: "Jede Aufnahme wird nach dem Upload auf Deutsch transkribiert – mit Sprechertrennung und einem Zeitstempel für jeden Satz. Lange Gespräche werden dafür abschnittsweise verarbeitet.",
  },
  {
    title: "Waveform-Wiedergabe",
    text: "Wellenform, Scrubbing, Lautstärke und Geschwindigkeit. Das Transkript läuft synchron mit und markiert die gerade gesprochene Passage.",
  },
  {
    title: "Suche über alles",
    text: "Volltextsuche über Metadaten und Transkripte. Jeder Treffer führt direkt an die passende Stelle der Aufnahme.",
  },
  {
    title: "Kommentare und Bewertungen",
    text: "Jede Aufnahme lässt sich kommentieren und auf einer Skala von 1 bis 10 bewerten. Autor und Zeitpunkt bleiben nachvollziehbar.",
  },
  {
    title: "Kontrollierte Löschung",
    text: "Mitarbeitende markieren Aufnahmen zur Löschung. Endgültig entfernt werden sie ausschliesslich durch die Administration.",
  },
];

export default function Home() {
  const hero = IMAGES.hero;
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex-1">
        <section className="border-b border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 lg:grid-cols-[1fr_620px] lg:items-center">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-petrol">
                Interne Anwendung
              </p>
              <h1 className="mt-3 text-4xl font-semibold leading-[1.1] tracking-tight text-ink">
                Jedes Verkaufsgespräch auffindbar, nachhörbar und bewertet.
              </h1>
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-soft">
                Die Gesprächsaufzeichnungen der Immotrust AG liegen an einem Ort: automatisch
                transkribiert, durchsuchbar bis auf den einzelnen Satz und für das gesamte
                Verkaufsteam gemeinsam nutzbar.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link prefetch={false} href="/anmelden" className="btn btn-primary">
                  Zur Anmeldung
                </Link>
                <Link prefetch={false} href="/registrieren" className="btn btn-secondary">
                  Konto erstellen
                </Link>
              </div>
              <dl className="mt-9 grid max-w-lg grid-cols-3 gap-4 border-t border-line pt-6">
                {[
                  ["Deutsch", "Transkription inkl. Sprechertrennung"],
                  ["1–10", "Bewertung pro Aufnahme"],
                  ["CET", "Zeitpunkte aus dem Dateinamen"],
                ].map(([term, description]) => (
                  <div key={term}>
                    <dt className="text-lg font-semibold text-ink">{term}</dt>
                    <dd className="mt-1 text-[12px] leading-snug text-ink-faint">{description}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="overflow-hidden rounded-md border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- Die WebP-Varianten werden zur Bauzeit erzeugt, eine Optimierung zur Laufzeit ist nicht erwünscht. */}
              <img
                src={hero.src}
                srcSet={hero.srcSet}
                sizes={hero.sizes}
                width={hero.width}
                height={hero.height}
                alt={hero.alt}
                fetchPriority="high"
                decoding="async"
                className="h-auto w-full"
                style={{ aspectRatio: `${hero.width} / ${hero.height}` }}
              />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="text-xl font-semibold tracking-tight text-ink">Was die Anwendung leistet</h2>
          <div className="mt-6 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <article key={feature.title} className="bg-surface p-5">
                <h3 className="text-[14px] font-semibold text-ink">{feature.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{feature.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 lg:grid-cols-[460px_1fr] lg:items-center">
            <div className="overflow-hidden rounded-md border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- Die WebP-Varianten werden zur Bauzeit erzeugt, eine Optimierung zur Laufzeit ist nicht erwünscht. */}
              <img
                src={IMAGES.portal.src}
                srcSet={IMAGES.portal.srcSet}
                sizes={IMAGES.portal.sizes}
                width={IMAGES.portal.width}
                height={IMAGES.portal.height}
                alt={IMAGES.portal.alt}
                loading="lazy"
                decoding="async"
                className="h-auto w-full"
                style={{ aspectRatio: `${IMAGES.portal.width} / ${IMAGES.portal.height}` }}
              />
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-ink">Zugang und Rollen</h2>
              <ul className="mt-5 space-y-4 text-[13px] leading-relaxed text-ink-soft">
                <li>
                  <strong className="font-semibold text-ink">Mitarbeitende</strong> registrieren sich
                  mit ihrer Geschäftsadresse, bestätigen die E-Mail-Adresse und sehen danach
                  sämtliche freigegebenen Aufnahmen.
                </li>
                <li>
                  <strong className="font-semibold text-ink">Gemeinsamer Bestand</strong>: Aufnahmen,
                  Transkripte, Kommentare und Bewertungen stehen dem ganzen Team zur Verfügung.
                </li>
                <li>
                  <strong className="font-semibold text-ink">Administration</strong>: Das
                  Admin-Dashboard steuert die Dateinamensvorlage, überwacht die Aufträge und
                  entscheidet über endgültige Löschungen.
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
