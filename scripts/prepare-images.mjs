// Lädt die zur Bauzeit erzeugten Bilder herunter und legt vorgerenderte
// WebP-Varianten in public/bilder ab, damit zur Laufzeit keine
// Bildverarbeitung nötig ist.
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const sources = {
  hero: "https://assets.clawcorp.ai/6a8206771f146d845392874c/gen/d6ef93687543ecbc5b312b131cf471d8-0.jpg",
  portal: "https://assets.clawcorp.ai/6a8206771f146d845392874c/gen/d7f2ea20cd60761d1422465b23787030-0.jpg",
};

const widths = [640, 960, 1440];
const target = new URL("../public/bilder/", import.meta.url);
await mkdir(target, { recursive: true });

for (const [name, url] of Object.entries(sources)) {
  const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
  const meta = await sharp(buffer).metadata();
  console.log(name, "original", meta.width, "x", meta.height);
  for (const width of widths) {
    if (meta.width && width > meta.width) continue;
    const out = await sharp(buffer).resize({ width }).webp({ quality: 76 }).toBuffer();
    await writeFile(new URL(`${name}-${width}.webp`, target), out);
    console.log("  ", `${name}-${width}.webp`, (out.length / 1024).toFixed(0), "KB");
  }
}
