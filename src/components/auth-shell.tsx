import Link from "next/link";
import { PublicFooter } from "@/components/brand";
import { Wordmark } from "@/components/brand";
import { IMAGES } from "@/lib/media";

export function AuthShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const image = IMAGES.portal;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-5">
          <Link prefetch={false} href="/" className="rounded-sm">
            <Wordmark />
          </Link>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto grid max-w-5xl gap-10 px-5 py-12 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-start">
          <section className="card p-7">
            <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{intro}</p>
            <div className="mt-6">{children}</div>
            {footer && <div className="mt-6 border-t border-line pt-4 text-[13px]">{footer}</div>}
          </section>
          <aside className="hidden overflow-hidden rounded-md border border-line lg:block">
            {/* eslint-disable-next-line @next/next/no-img-element -- Die WebP-Varianten werden zur Bauzeit erzeugt, eine Optimierung zur Laufzeit ist nicht erwünscht. */}
            <img
              src={image.src}
              srcSet={image.srcSet}
              sizes={image.sizes}
              width={image.width}
              height={image.height}
              alt={image.alt}
              loading="lazy"
              decoding="async"
              className="h-auto w-full"
              style={{ aspectRatio: `${image.width} / ${image.height}` }}
            />
            <div className="border-t border-line bg-surface p-5">
              <h2 className="text-[13px] font-semibold text-ink">Hinweis zum Zugang</h2>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
                Zugelassen sind ausschliesslich E-Mail-Adressen der Domain @immotrustag.ch sowie die
                Adresse des Superusers. Die E-Mail-Adresse muss vor der ersten Anmeldung bestätigt
                werden.
              </p>
            </div>
          </aside>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
