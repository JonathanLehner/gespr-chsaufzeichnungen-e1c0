/**
 * Bilder der öffentlichen Seiten. Sie wurden einmalig zur Bauzeit erzeugt
 * (scripts/generate-images.mjs) und als WebP-Varianten in public/bilder
 * abgelegt (scripts/prepare-images.mjs). Zur Laufzeit findet dadurch weder
 * eine Generierung noch eine Bildverarbeitung statt.
 */
export type StaticImage = {
  src: string;
  srcSet: string;
  sizes: string;
  width: number;
  height: number;
  alt: string;
  /** Winzige, unscharfe Vorschau als data-URI, sichtbar bis das eigentliche Bild geladen ist. */
  placeholder?: string;
};

export const IMAGES: Record<"hero" | "portal", StaticImage> = {
  hero: {
    src: "/bilder/hero-960.webp",
    srcSet: "/bilder/hero-640.webp 640w, /bilder/hero-960.webp 960w",
    sizes: "(max-width: 900px) 100vw, 620px",
    width: 1376,
    height: 768,
    alt: "Berater der Immotrust AG im Verkaufsgespräch am Telefon im Büro in Zürich",
  },
  portal: {
    src: "/bilder/portal-960.webp",
    srcSet: "/bilder/portal-640.webp 640w, /bilder/portal-960.webp 960w",
    sizes: "(max-width: 1024px) 100vw, 460px",
    width: 1200,
    height: 896,
    alt: "Besprechungsraum der Immotrust AG mit Blick über die Dächer der Stadt",
    placeholder:
      "data:image/webp;base64,UklGRqQAAABXRUJQVlA4IJgAAAAwBQCdASoYABIAPtFcpE6oJSMiKAqpABoJQBh1ggqaZNARuZ/ymxJrUtaUDfaltQrfAAD+43GuJtPZf4fQvFBYBRihC3pXTdKZszzW+jZde1S4mlvqeGfRWUoA/hZi4SYjGI0wgrrw2f/vc/fZSuGpwKpRL7H596+ZdOk+lMBu+Y7wOTLhxZK6VXG2EXGyoAw3bN6STMAAAA==",
  },
};
