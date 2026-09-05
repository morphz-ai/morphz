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

test("the context-maintenance article uses the same transaction in both languages", async () => {
  const slug = "maintaining-context-without-compaction.md";
  const sources = await Promise.all(["zh", "en"].map((locale) =>
    readFile(new URL(`${locale}/${slug}`, contentRoot), "utf8"),
  ));
  const examples = sources.map((source) => source.match(/```lisp\n([\s\S]*?)\n```/)?.[1]);
  assert.ok(examples[0], "Chinese article includes the example transaction");
  assert.equal(examples[0], examples[1]);
  assert.match(examples[0], /\(from @e42 deployment\/target-v1\)/);
  assert.match(examples[0], /\(relate deployment\/target-v2 supersedes deployment\/target-v1\)/);
  assert.match(examples[0], /\(retire deployment\/target-v1\)/);
  assert.match(examples[0], /\(retire @e42\)/);
  for (const [index, locale] of ["zh", "en"].entries()) {
    const prefix = locale === "zh" ? "" : "/en";
    for (const related of ["/docs/contexts-and-recall", "/paper", "/blog/from-chat-completion-to-structured-context-evaluation"]) {
      assert.ok(sources[index].includes(`](${prefix}${related})`), `${locale} links to ${related} in its own language`);
    }
  }
});

test("the context-maintenance article defines observations before using them in transactions", async () => {
  const slug = "maintaining-context-without-compaction.md";
  const [zh, en] = await Promise.all(["zh", "en"].map((locale) =>
    readFile(new URL(`${locale}/${slug}`, contentRoot), "utf8"),
  ));
  assert.match(zh.split("```lisp")[0], /观察（Observation）是一条.*输入记录/);
  assert.match(en.split("```lisp")[0], /an observation is an input record/);
  assert.doesNotMatch(zh, /观察退役/);
});

test("the context-maintenance article reports frozen cache and memory results in both languages", async () => {
  const slug = "maintaining-context-without-compaction.md";
  const artifacts = new URL("../../docs/research/paper_evaluation/artifacts/", import.meta.url);
  const [cache, memory] = await Promise.all([
    "prompt_cache_nine_model_real_task_delta_ab_20260830.json",
    "me07_public_agent_systems_formal_one_run_20260827/formal_summary.json",
  ].map(async (path) => JSON.parse(await readFile(new URL(path, artifacts), "utf8"))));

  for (const locale of ["zh", "en"]) {
    const source = await readFile(new URL(`${locale}/${slug}`, contentRoot), "utf8");
    const cacheHeading = locale === "zh" ? "前缀缓存" : "Prefix caching";
    const cacheSection = source.split(`## ${cacheHeading}\n`)[1]?.split("\n## ")[0];
    assert.ok(cacheSection, `${locale} gives prefix caching its own section`);
    assert.equal(cache.summary_excludes_first_request, true);
    for (const [model, displayName] of [["k3-256k", "Kimi K3"], ["glm-5.3", "GLM 5.3"], ["gpt-5.6-sol", "GPT-5.6 Sol"]]) {
      const result = cache.models.find((entry) => entry.model === model);
      assert.ok(result, `frozen cache results include ${model}`);
      const paragraph = cacheSection.split("\n\n").find((text) => text.includes(displayName));
      assert.ok(paragraph, `${locale} identifies the tested model ${displayName}`);
      const rate = `${(result.default_steady_cache_hit_rate * 100).toFixed(2)}%`;
      assert.ok(paragraph.includes(rate), `${locale} associates default cache reuse with ${displayName}`);
      if (model === "gpt-5.6-sol") {
        const deltaRate = `${(result.delta_steady_cached_input_tokens / result.delta_steady_input_tokens * 100).toFixed(2)}%`;
        assert.ok(paragraph.includes(deltaRate), `${locale} scopes the ContextDelta comparison to GPT`);
      }
    }
    for (const arm of Object.values(memory.arm_summary)) {
      const passed = Math.round(arm["task_completion_pass@1"] * arm.tasks);
      assert.ok(source.includes(`${passed}/${arm.tasks}`), `${locale} includes frozen task completion counts`);
      assert.ok(source.includes(`${(arm["task_completion_pass@1"] * 100).toFixed(2)}%`), `${locale} includes frozen completion rates`);
    }
    assert.match(cacheSection, locale === "zh" ? /首轮之后/ : /excluding each run's first request/);
    assert.match(cacheSection, /prompt_cache_nine_model_real_task_no_delta_20260830\.md/);
    assert.match(cacheSection, /prompt_cache_nine_model_real_task_delta_ab_20260830\.md/);
    assert.match(source, /me07_public_agent_systems_formal_one_run_20260827\/README\.md/);
    assert.match(source, locale === "zh" ? /默认关闭/ : /disabled by default/);
    assert.match(source, locale === "zh" ? /STATE-Bench 的任务、评分规则和评测提示词/ : /STATE-Bench tasks, scoring rules, and evaluation prompts/);
    assert.doesNotMatch(source, locale === "zh" ? /更新评测协议|更新了用户模拟器/ : /updated evaluation protocol|updated user-simulator/);
  }
});
