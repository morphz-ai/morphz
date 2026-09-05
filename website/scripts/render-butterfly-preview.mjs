import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

// Standalone concept export. The live mark, favicon, and OG images stay intact.
const require = createRequire(import.meta.url);
const sharp = require(process.env.MORPHZ_BRAND_SHARP || "sharp");
const root = new URL("../public/brand/", import.meta.url);
const version = process.argv[2] || "v1";
if (!["v1", "v2"].includes(version)) throw new Error("Choose v1 or v2.");
const name = `morphz-butterfly-${version}`;
const source = await readFile(new URL(`${name}.svg`, root));
await sharp(source, { density: version === "v1" ? 192 : 768 }).resize(512, 512).png().toFile(new URL(`${name}-512.png`, root).pathname);

const embedded = source.toString("base64");
const mark = (x, y, size) => `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${embedded}"/>`;
const proof = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680">
  <rect width="600" height="680" fill="#0b1117"/>
  <rect x="600" width="600" height="680" fill="#f3f6f8"/>
  ${mark(84, 66, 432)}
  ${mark(684, 66, 432)}
  ${mark(213, 550, 32)}
  ${mark(273, 542, 48)}
  ${mark(349, 534, 64)}
  ${mark(813, 550, 32)}
  ${mark(873, 542, 48)}
  ${mark(949, 534, 64)}
</svg>`;
await writeFile(new URL(`${name}-preview.svg`, root), proof);
await sharp(Buffer.from(proof)).png().toFile(new URL(`${name}-preview.png`, root).pathname);

if (version === "v2") {
  const original = (await readFile(new URL("morphz-mark-cyan.svg", root))).toString("base64");
  const comparison = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="580" viewBox="0 0 1200 580">
    <rect width="1200" height="580" fill="#0b1117"/>
    <path d="M600 64V516" stroke="#273039"/>
    <g fill="#9ba9b4" font-family="Arial, Helvetica, sans-serif" font-size="14" letter-spacing="2" text-anchor="middle">
      <text x="300" y="72">ORIGINAL M</text>
      <text x="900" y="72">BUTTERFLY / V2</text>
    </g>
    <image x="132" y="128" width="336" height="336" href="data:image/svg+xml;base64,${original}"/>
    ${mark(732, 128, 336)}
  </svg>`;
  await writeFile(new URL(`${name}-comparison.svg`, root), comparison);
  await sharp(Buffer.from(comparison)).png().toFile(new URL(`${name}-comparison.png`, root).pathname);
}
console.log(`Exported the butterfly ${version} concept and its previews.`);
