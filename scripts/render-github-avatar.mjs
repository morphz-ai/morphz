import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const sharp = require(process.env.MORPHZ_BRAND_SHARP || "sharp");
const root = new URL("../assets/brand/", import.meta.url);
const source = await readFile(new URL("morphz-avatar-cyan.svg", root));
await sharp(source, { density: 144 })
  .resize(512, 512)
  .png()
  .toFile(new URL("morphz-avatar-cyan-512.png", root).pathname);
console.log("Exported the electric-cyan GitHub avatar.");
