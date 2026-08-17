// Erzeugt aus der Bildmarke (public/logo.png) einmalig zur Bauzeit die
// Anzeigevariante für Kopf-/Fusszeile sowie die Icon-Formate, die Browser und
// Betriebssysteme erwarten. Zur Laufzeit findet dadurch keine Bildverarbeitung
// statt.
//
//   node scripts/generate-logo-assets.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const markDir = new URL("../public/marke/", import.meta.url);
const appDir = new URL("../src/app/", import.meta.url);
const source = await readFile(new URL("../public/logo.png", import.meta.url));

await mkdir(markDir, { recursive: true });

/** Rendert die Marke quadratisch mit transparentem Rand, ohne sie zu verzerren. */
async function square(size, { background = { r: 0, g: 0, b: 0, alpha: 0 }, padding = 0 } = {}) {
  const inner = Math.round(size * (1 - padding));
  return sharp(source)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: Math.floor((size - inner) / 2),
      bottom: Math.ceil((size - inner) / 2),
      left: Math.floor((size - inner) / 2),
      right: Math.ceil((size - inner) / 2),
      background,
    })
    .flatten(background.alpha === 0 ? false : { background })
    // Die Marke kommt mit wenigen Farbtönen aus; die Palette spart rund zwei Drittel.
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();
}

/** Verpackt PNG-Varianten in einen ICO-Container (PNG-in-ICO, ab IE11 unterstützt). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserviert
  header.writeUInt16LE(1, 2); // Typ: Icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const directory = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // Farbpalette
    entry.writeUInt8(0, 3); // reserviert
    entry.writeUInt16LE(1, 4); // Ebenen
    entry.writeUInt16LE(32, 6); // Bit pro Pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...images.map((image) => image.data)]);
}

// Anzeigevariante: wird mit 18–28 px dargestellt, 112 px deckt auch 4x-Displays ab.
const display = await sharp(source).resize({ width: 112 }).webp({ quality: 92 }).toBuffer();
await writeFile(new URL("logo-112.webp", markDir), display);

const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(async (size) => ({ size, data: await square(size) })));
await writeFile(new URL("favicon.ico", appDir), ico(images));

// Der Brief begrenzt src/app/icon.* auf 128 px Kantenlänge.
await writeFile(new URL("icon.png", appDir), await square(128));

// iOS legt Touch-Icons auf schwarzem Grund ab, deshalb hier weisser Hintergrund.
await writeFile(
  new URL("apple-icon.png", appDir),
  await square(180, { background: { r: 255, g: 255, b: 255, alpha: 1 }, padding: 0.12 }),
);

console.log("logo-112.webp, favicon.ico, icon.png (128px), apple-icon.png (180px) erzeugt.");
