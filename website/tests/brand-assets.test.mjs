import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../public/brand/", import.meta.url);
const names = ["morphz-mark", "morphz-mark-ink", "morphz-mark-white", "morphz-mark-cyan"];
const favicons = ["morphz-favicon", "morphz-favicon-cyan"];
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

test("brand masters preserve the silhouette with seamless monochrome wings", async () => {
  const sources = await Promise.all(names.map((name) => readFile(new URL(`${name}.svg`, root), "utf8")));
  const paths = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  const shadedPaths = [
    "M8 4 38 31 38 70 8 92Z",
    "M88 4 58 31 58 70 88 92Z",
    "M38 31 48 40 38 40Z",
    "M58 31 48 40 58 40Z",
  ];
  // The monochrome contours include the folds in each wing. Separate adjacent
  // paths leave a translucent antialiasing seam along x=38 and x=58.
  const seamlessPaths = [
    "M8 4 48 40 38 40 38 70 8 92Z",
    "M88 4 48 40 58 40 58 70 88 92Z",
  ];
  for (const [index, svg] of sources.entries()) {
    assert.match(svg, /viewBox="0 0 96 96"/);
    assert.match(svg, /<title id="title">Morphz<\/title>/);
    assert.deepEqual(paths(svg), index === 0 ? shadedPaths : seamlessPaths, names[index]);
    assert.doesNotMatch(svg, /<(?:image|script|foreignObject|filter|text)\b/);
    assert.doesNotMatch(svg, /(?:href|src)\s*=/);
  }
});

test("transparent exports exist at their advertised pixel sizes", async () => {
  for (const name of [...names, ...favicons]) {
    for (const size of favicons.includes(name) ? [16, 32, 48] : sizes) {
      const png = await readFile(new URL(`${name}-${size}.png`, root));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      assert.equal(png[25], 6, "PNG uses RGBA, retaining the transparent background");
    }
  }
});

test("small-size favicon uses two solid wings without dark inset folds", async () => {
  const svg = await readFile(new URL("morphz-favicon.svg", root), "utf8");
  assert.match(svg, /viewBox="0 0 32 32"/);
  assert.equal([...svg.matchAll(/<path\b/g)].length, 2);
  assert.match(svg, /fill="#009af5"/);
  assert.match(svg, /fill="#6545f6"/);
  assert.doesNotMatch(svg, /<(?:linearGradient|radialGradient|filter|image|script)\b/);
  assert.doesNotMatch(svg, /opacity/);
});

test("cyan mark and favicon use one opaque electric-cyan fill", async () => {
  for (const name of ["morphz-mark-cyan", "morphz-favicon-cyan"]) {
    const svg = await readFile(new URL(`${name}.svg`, root), "utf8");
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(fills, ["#56d0de"]);
    assert.doesNotMatch(svg, /<(?:linearGradient|radialGradient|filter|image|script)\b|opacity/);
  }
});

test("GitHub avatar preserves the website mark with room for a circular crop", async () => {
  const avatar = await readFile(new URL("../../assets/brand/morphz-avatar-cyan.svg", import.meta.url), "utf8");
  const mark = await readFile(new URL("morphz-mark-cyan.svg", root), "utf8");
  const paths = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(paths(avatar), paths(mark));
  assert.match(avatar, /fill="#56d0de"/);
  assert.match(avatar, /<rect width="256" height="256" fill="#17191d"/);
  assert.match(avatar, /translate\(36\.8 36\.8\) scale\(1\.9\)/);
  // Every corner of the mark's bounding box fits inside the avatar's circle.
  for (const x of [8, 88]) {
    for (const y of [4, 92]) {
      assert.ok(Math.hypot(x * 1.9 + 36.8 - 128, y * 1.9 + 36.8 - 128) < 128);
    }
  }
  const png = await readFile(new URL("../../assets/brand/morphz-avatar-cyan-512.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});

test("both repository READMEs use the same primary mark as the website", async () => {
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const markdown = await readFile(new URL(`../../${name}`, import.meta.url), "utf8");
    assert.match(markdown, /<img src="website\/public\/brand\/morphz-mark-cyan\.svg" alt="Morphz"/);
    assert.doesNotMatch(markdown, /<img src="assets\/brand\/morphz-mark\.svg"/);
  }
});
