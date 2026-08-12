import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const contentRoot = new URL("../content/docs/", import.meta.url);

async function files(locale) {
  return (await readdir(new URL(`${locale}/`, contentRoot))).filter((file) => file.endsWith(".md")).sort();
}

test("keeps Chinese and English documentation slugs in parity", async () => {
  assert.deepEqual(await files("zh"), await files("en"));
});

test("requires publication metadata and avoids legacy terminology", async () => {
  for (const locale of ["zh", "en"]) {
    for (const filename of await files(locale)) {
      const source = await readFile(new URL(`${locale}/${filename}`, contentRoot), "utf8");
      for (const field of ["title", "description", "section", "order", "status"]) {
        assert.match(source, new RegExp(`^${field}:\\s*.+$`, "m"), `${locale}/${filename} missing ${field}`);
      }
      assert.match(source, /^status:\s*(current|preview)$/m);
      if (locale === "zh") assert.doesNotMatch(source, /认知框架/, `${filename} uses the retired term 认知框架`);
    }
  }
});

test("all absolute documentation links point to existing pages", async () => {
  const known = new Set(await files("zh").then((items) => items.map((file) => file.replace(/\.md$/, ""))));
  for (const locale of ["zh", "en"]) {
    for (const filename of await files(locale)) {
      const source = await readFile(new URL(`${locale}/${filename}`, contentRoot), "utf8");
      for (const match of source.matchAll(/\]\(\/(?:en\/)?docs\/([a-z0-9-]+)\)/g)) {
        assert.ok(known.has(match[1]), `${locale}/${filename} links to missing ${match[1]}`);
      }
    }
  }
});
