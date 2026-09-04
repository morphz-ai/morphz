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

test("publishes the current core capability map in both languages", async () => {
  const required = [
    "agent-trajectories.md",
    "cognitive-applications.md",
    "contexts-and-recall.md",
    "core-concepts.md",
    "execution-lifecycle.md",
    "principals-and-authority.md",
    "sessions-and-concurrency.md",
  ];
  for (const locale of ["zh", "en"]) {
    const available = await files(locale);
    for (const filename of required) assert.ok(available.includes(filename), `${locale} missing ${filename}`);
  }

  const zhContext = await readFile(new URL("zh/contexts-and-recall.md", contentRoot), "utf8");
  assert.match(zhContext, /窗口使用认知时钟计量/);
  assert.match(zhContext, /后继认知帧同时把旧帧列为来源并声明/);
  assert.match(zhContext, /退役只表示内容退出当前活动编码，不代表事实错误、认知失效或物理删除/);
  assert.match(zhContext, /context audit/);

  const zhSessions = await readFile(new URL("zh/sessions-and-concurrency.md", contentRoot), "utf8");
  assert.match(zhSessions, /retire-session/);
  assert.match(zhSessions, /让会话退出当前注意窗口，同时保留会话身份/);

  const zhApplications = await readFile(new URL("zh/cognitive-applications.md", contentRoot), "utf8");
  assert.match(zhApplications, /安装不等于运行或授权/);
  assert.match(zhApplications, /精确领域程序标识、版本和制品哈希/);

  const zhTrajectories = await readFile(new URL("zh/agent-trajectories.md", contentRoot), "utf8");
  assert.match(zhTrajectories, /执行轨迹只投影其中与指定范围有关的因果状态转换/);
  assert.match(zhTrajectories, /AT-Training/);

  const zhCore = await readFile(new URL("zh/core-concepts.md", contentRoot), "utf8");
  assert.match(zhCore, /长期记忆由权威事件历史、智能体维护的认知状态/);
  assert.match(zhCore, /认知自进化/);
  assert.match(zhCore, /主体是进入运行时的稳定身份与授权来源/);

  const zhPrincipals = await readFile(new URL("zh/principals-and-authority.md", contentRoot), "utf8");
  assert.match(zhPrincipals, /谁正在与智能体交互，以及这次行动的权限来自谁/);
  assert.doesNotMatch(zhPrincipals, /Principal/);

  const zhLifecycle = await readFile(new URL("zh/execution-lifecycle.md", contentRoot), "utf8");
  assert.match(zhLifecycle, /代次标识目标的一轮有效推进/);
  assert.match(zhLifecycle, /线程代次隔离同一条逻辑线程/);

  const enCore = await readFile(new URL("en/core-concepts.md", contentRoot), "utf8");
  assert.match(enCore, /long-term memory through authoritative Event History/);
  assert.match(enCore, /self-evolving cognition/);
  assert.match(enCore, /A Principal is the stable identity and authority source/);

  const enPrincipals = await readFile(new URL("en/principals-and-authority.md", contentRoot), "utf8");
  assert.match(enPrincipals, /stable identity and source of authority/);
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

  const chinese = await readFile(new URL("zh/cli-reference.md", contentRoot), "utf8");
  assert.match(chinese, /管理持久智能体/);
  assert.doesNotMatch(chinese, /管理持久代理/);
});

test("keeps public documentation free of release-preparation and editor notes", async () => {
  const prohibited = {
    zh: /代码仓库公开前|私有 GitHub Release|发布前稳定期|请不要直接编辑|界面应明确|不应凭空生成|默认值支持 43 张|我们/,
    en: /before the repository is public|private GitHub Releases|pre-release stabilization|do not edit it directly|the UI should expose|must not invent|43-screenshot|\b(?:we|our|maintainers?)\b/i,
  };

  for (const locale of ["zh", "en"]) {
    for (const filename of await files(locale)) {
      const source = await readFile(new URL(`${locale}/${filename}`, contentRoot), "utf8");
      assert.doesNotMatch(source, prohibited[locale], `${locale}/${filename} contains an internal or editorial note`);
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
    "morphz target authorize",
    "morphz harness install",
    "morphz trajectory verify",
    "morphz storage migrate-cognitive-store",
    "morphz update",
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
