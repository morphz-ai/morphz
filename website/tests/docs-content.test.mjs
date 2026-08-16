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

test("keeps product-domain prose in the page language", async () => {
  const englishDomainTerms = /\b(?:Agent|Context|Session|Thread|Activation|Objective|Recall|Runtime|Provider|Dashboard|Setup|Sandbox|Principal|Gateway|Event History|Prompt|Token|Execution Target|Harness)\b/;
  for (const filename of await files("zh")) {
    const source = await readFile(new URL(`zh/${filename}`, contentRoot), "utf8");
    const prose = source
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]*`/g, "")
      .replace(/^source:\s*.+$/gm, "");
    assert.doesNotMatch(prose, englishDomainTerms, `zh/${filename} mixes English product terminology into Chinese prose`);
  }

  for (const filename of await files("en")) {
    const source = await readFile(new URL(`en/${filename}`, contentRoot), "utf8");
    assert.doesNotMatch(source, /[\u3400-\u9fff]/, `en/${filename} contains Chinese prose`);
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

test("publishes the generated bilingual CLI reference", async () => {
  const requiredCommands = [
    "morphz setup",
    "morphz serve",
    "morphz context recall search",
    "morphz objective create",
    "morphz scheduler thread resume",
    "morphz provider account login",
  ];

  for (const locale of ["zh", "en"]) {
    const source = await readFile(new URL(`${locale}/cli-reference.md`, contentRoot), "utf8");
    assert.match(source, /^source:\s*generated-cli-schema$/m);
    assert.match(source, /generated from|自动生成/i);
    for (const command of requiredCommands) {
      assert.ok(source.includes(`\`${command}\``), `${locale}/cli-reference.md missing ${command}`);
    }
  }
});
