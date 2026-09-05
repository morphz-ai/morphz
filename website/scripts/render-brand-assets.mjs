import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

// Optional export tooling, separate from the website build. Resolve an existing
// sharp installation or pass its absolute module path in MORPHZ_BRAND_SHARP.
const require = createRequire(import.meta.url);
const sharp = require(process.env.MORPHZ_BRAND_SHARP || "sharp");
const assetRoot = new URL("../public/brand/", import.meta.url);
const variants = ["morphz-mark", "morphz-mark-ink", "morphz-mark-white", "morphz-mark-cyan"];
const favicons = ["morphz-favicon", "morphz-favicon-cyan"];
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const assets = new Map();
let exportedCount = 0;

for (const name of [...variants, ...favicons]) {
  const source = await readFile(new URL(`${name}.svg`, assetRoot));
  assets.set(name, source);
  for (const size of favicons.includes(name) ? [16, 32, 48] : sizes) {
    const png = await sharp(source, { density: 768 }).resize(size, size).png().toBuffer();
    await writeFile(new URL(`${name}-${size}.png`, assetRoot), png);
    exportedCount++;
  }
}

// This proof sheet embeds the actual exported source, keeping the review tied
// to the shipped SVGs. It creates a new image and never edits the OG artwork.
function mark(name, x, y, size) {
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${assets.get(name).toString("base64")}"/>`;
}

function label(text, x, y, size = 14, color = "#94a1b1", spacing = 1.8) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" letter-spacing="${spacing}">${text}</text>`;
}

const columns = [64, 432, 800];
const panelWidth = 336;
const panels = [
  { name: "morphz-mark-cyan", fill: "#101720", title: "ELECTRIC CYAN / DARK", text: "#94a1b1" },
  { name: "morphz-mark-cyan", fill: "#f3f5f8", title: "ELECTRIC CYAN / LIGHT", text: "#556272" },
  { name: "morphz-mark-ink", fill: "#f3f5f8", title: "MONO / LIGHT", text: "#556272" },
];

let body = `<rect width="1200" height="1040" fill="#080d13"/>`;
body += label("MORPHZ / IDENTITY", 64, 66, 13, "#62cbd9");
body += label("The M. The wings.", 64, 128, 45, "#f0f4f9", -1.2);
body += label("A geometric mark, drawn from the original sharing cover.", 64, 164, 17, "#94a1b1", 0);

for (let i = 0; i < panels.length; i++) {
  const panel = panels[i];
  const x = columns[i];
  body += `<rect x="${x}" y="208" width="${panelWidth}" height="298" rx="20" fill="${panel.fill}"/>`;
  body += label(panel.title, x + 24, 245, 12, panel.text);
  body += mark(panel.name, x + 80, 281, 176);
}

body += `<rect x="64" y="538" width="520" height="208" rx="20" fill="#101720"/>`;
body += label("MONO / DARK", 88, 575, 12);
body += mark("morphz-mark-white", 105, 600, 104);
body += label("Morphz", 237, 680, 59, "#ffffff", -2);

body += `<rect x="616" y="538" width="520" height="208" rx="20" fill="#101720"/>`;
body += label("SILHOUETTE / UNCHANGED", 640, 575, 12);
body += mark("morphz-mark", 675, 609, 96);
body += mark("morphz-mark-white", 833, 609, 96);
body += label("COLOR", 692, 727, 10);
body += label("MONO", 852, 727, 10);

body += label("FAVICON / ACTUAL PIXEL SIZES", 64, 802, 12);
const smallSizes = [16, 24, 32, 48, 64];
for (let i = 0; i < smallSizes.length; i++) {
  const size = smallSizes[i];
  const x = 64 + i * 218;
  body += `<rect x="${x}" y="826" width="202" height="130" rx="14" fill="#f3f5f8"/>`;
  body += mark("morphz-favicon-cyan", x + (202 - size) / 2, 867 - size / 2, size);
  body += label(`${size} PX`, x + 80, 928, 11, "#556272", 0.8);
}
body += label("SVG masters + transparent PNG exports / 16–512 px", 64, 1000, 13, "#94a1b1", 0);

const proof = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1040" viewBox="0 0 1200 1040">${body}</svg>`;
await writeFile(new URL("preview.svg", assetRoot), proof);
await sharp(Buffer.from(proof)).png().toFile(new URL("preview.png", assetRoot).pathname);
console.log(`Exported ${exportedCount} transparent PNGs and the identity proof sheet.`);
