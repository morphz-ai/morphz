import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const contentRoot = new URL("../content/blog/", import.meta.url);

async function files(locale) {
  return (await readdir(new URL(`${locale}/`, contentRoot))).filter((file) => file.endsWith(".md")).sort();
}

test("keeps Chinese and English blog slugs in parity", async () => {
  assert.deepEqual(await files("zh"), await files("en"));
});

test("requires publication metadata for every blog post", async () => {
  for (const locale of ["zh", "en"]) {
    for (const filename of await files(locale)) {
      const source = await readFile(new URL(`${locale}/${filename}`, contentRoot), "utf8");
      for (const field of ["title", "description", "published", "author", "category"]) {
        assert.match(source, new RegExp(`^${field}:\\s*.+$`, "m"), `${locale}/${filename} missing ${field}`);
      }
      assert.match(source, /^published:\s*\d{4}-\d{2}-\d{2}$/m);
      assert.match(source, /^author:\s*Morphz Project$/m);
    }
  }
});

test("the inaugural essay names and distinguishes the new computational model", async () => {
  const slug = "from-chat-completion-to-structured-context-evaluation.md";
  const [zh, en] = await Promise.all([
    readFile(new URL(`zh/${slug}`, contentRoot), "utf8"),
    readFile(new URL(`en/${slug}`, contentRoot), "utf8"),
  ]);
  assert.match(zh, /结构不是一种序列化格式/);
  assert.match(zh, /context\[t\+1\] = evaluate/);
  assert.match(zh, /非确定性的语义求值器/);
  assert.doesNotMatch(zh, /代理/);
  assert.match(zh, /\(protocol \.\.\.\)\n {2}\(evaluation-profile none\)\n {2}\(inbox \.\.\.\)/);
  assert.match(zh, /候选求值程序/);
  assert.match(zh, /\[研究论文\]\(\/paper\)/);
  assert.doesNotMatch(zh, /Developer Preview|业务真理|Morphz 0\.1|一台认知机/);
  assert.doesNotMatch(zh, /我诞生于|我叫 Morphz|对我而言/);
  assert.match(en, /Structure is not a serialization format/);
  assert.match(en, /context\[t\+1\] = evaluate/);
  assert.match(en, /nondeterministic semantic evaluator/);
  assert.match(en, /\(protocol \.\.\.\)\n {2}\(evaluation-profile none\)\n {2}\(inbox \.\.\.\)/);
  assert.match(en, /candidate evaluation program/);
  assert.match(en, /\[research paper\]\(\/en\/paper\)/);
  assert.doesNotMatch(en, /Developer Preview|Morphz 0\.1 runtime|cognitive machine/);
  assert.doesNotMatch(en, /I began with|I am Morphz|To me, chat/);
});
