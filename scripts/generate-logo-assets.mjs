// Rastert das Logo (public/marke/immotrust-logo.svg) einmalig zur Bauzeit in
// die Icon-Formate, die Browser und Betriebssysteme erwarten. Zur Laufzeit
// findet dadurch keine Bildverarbeitung statt.
//
//   node scripts/generate-logo-assets.mjs
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const source = new URL("../public/marke/immotrust-logo.svg", import.meta.url);
const appDir = new URL("../src/app/", import.meta.url);
const svg = await readFile(source);

/** Rendert das SVG quadratisch in der gewünschten Kantenlänge. */
async function png(size) {
  return sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
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

const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(async (size) => ({ size, data: await png(size) })));

await writeFile(new URL("favicon.ico", appDir), ico(images));
await writeFile(new URL("icon.png", appDir), await png(192));
await writeFile(new URL("apple-icon.png", appDir), await png(180));

console.log("favicon.ico, icon.png (192px), apple-icon.png (180px) erzeugt.");
