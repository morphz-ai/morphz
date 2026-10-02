/** Explicit opt-in usage of an already configured model through a trusted local
 * proxy. Synthetic UI inputs only, fresh Host/Runtime DBs, no original Profile
 * or history. Provider key comes solely from this process's dedicated env var;
 * no credential discovery, login, configuration mutation or secret output. */
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "@playwright/test";
import { profileActualTransportFixture } from "../tests/profile-actual-transport-fixture.js";
import { defaultAgentProfile } from "../packages/core/src/profile.js";

const key = process.env.MORPHZ_PROFILE_LIVE_KEY;
const model = process.env.MORPHZ_PROFILE_LIVE_MODEL;
const baseUrl = process.env.MORPHZ_PROFILE_LIVE_BASE_URL;
assert.ok(
  key && model && baseUrl,
  "Explicit MORPHZ_PROFILE_LIVE_KEY, MODEL and BASE_URL are required; this probe incurs real model usage.",
);
assert.ok(
  key.length <= 8192 && /^[\x21-\x7e]+$/.test(key),
  "Dedicated live credential is invalid; it was not sent",
);
const endpoint = new URL(baseUrl);
assert.ok(
  endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash,
  "Only the explicitly configured trusted loopback proxy is accepted",
);
const protocol = process.env.MORPHZ_PROFILE_LIVE_PROTOCOL ?? "openai-responses";
assert.ok(protocol === "openai-chat" || protocol === "openai-responses");
const fixture = await profileActualTransportFixture({
  realProvider: { key, model, baseUrl, protocol },
});
let browser: Browser | undefined;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
function outputText(raw: string) {
  if (!raw.startsWith("event:") && !raw.startsWith("data:")) {
    const value = JSON.parse(raw);
    return (
      value.choices?.[0]?.message?.content ??
      value.output
        ?.flatMap(
          (item: { content?: { text?: string }[] }) =>
            item.content?.map((part) => part.text ?? "") ?? [],
        )
        .join("") ??
      ""
    );
  }
  let delta = "",
    done = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]")
      continue;
    const value = JSON.parse(line.slice(5));
    if (value.type === "response.output_text.delta") delta += value.delta ?? "";
    if (value.type === "response.output_text.done") done += value.text ?? "";
    if (value.choices?.[0]?.delta?.content)
      delta += value.choices[0].delta.content;
  }
  return done || delta;
}
async function ask(page: Page, marker: string) {
  const first = fixture.requests.length,
    reply = fixture.modelReplies.length;
  const input = page.getByRole("textbox", { name: "AI 输入内容", exact: true });
  await input.fill(
    marker +
      "：仅按当前已安装的只读 Profile 回答幽默的配置。已设置就报告准确的数字/5，没设置就说‘未设置’，不要推测默认值；它不是模型参数。不调用工具。",
  );
  await input.press("Enter");
  const request = await fixture.waitRequest(marker, first);
  for (
    let count = 0;
    count < 900 && fixture.modelReplies.length <= reply;
    count++
  )
    await pause(100);
  assert.ok(
    fixture.modelReplies.length > reply,
    "Real model response did not arrive",
  );
  return {
    messages: JSON.stringify(request.messages),
    text: outputText(fixture.modelReplies[reply]!),
  };
}
try {
  browser = await chromium.launch({
    executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  await page.goto(fixture.origin);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const initial = await fixture.read();
  assert.deepEqual(initial.agent.data, defaultAgentProfile);
  assert.equal(initial.agent.enabled, false);
  const unset = await ask(page, "TEST_PROFILE_LIVE_UNSET");
  assert.ok(
    !unset.messages.includes("(agent-profile ") &&
      !unset.messages.includes(
        "Installed agent-rom is caller-owned read-only configuration",
      ),
  );
  const panel = page.locator(".subject-sidebar");
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const editor = panel.getByRole("region", { name: "智能体资料", exact: true });
  await editor.getByRole("checkbox", { name: "设置幽默", exact: true }).check();
  const slider = editor.getByRole("slider", { name: "幽默程度", exact: true });
  await slider.press("End");
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .check();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".personality-save-state")
      ?.textContent?.startsWith("已保存"),
  );
  const actual = await fixture.read();
  assert.equal(actual.agent.data.traits.humor, 5);
  assert.equal(actual.agent.enabled, true);
  const configured = await ask(page, "TEST_PROFILE_LIVE_CONFIGURED");
  assert.ok(configured.messages.includes("(humor 5)"));
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .uncheck();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".personality-save-state")
      ?.textContent?.startsWith("已保存"),
  );
  assert.equal((await fixture.read()).agent.enabled, false);
  assert.equal(
    await editor
      .getByRole("checkbox", { name: "使用 Profile", exact: true })
      .isChecked(),
    false,
  );
  const disabled = await ask(page, "TEST_PROFILE_LIVE_DISABLED");
  assert.ok(
    !disabled.messages.includes("(agent-profile ") &&
      !disabled.messages.includes(
        "Installed agent-rom is caller-owned read-only configuration",
      ),
  );
  // These are observed real-model answers, not subjective humor quality scores.
  const evidence = {
    realModel: true,
    realUiHostRust: true,
    model,
    provider: endpoint.origin,
    requests: fixture.requests.length,
    initial: unset.text,
    configured: configured.text,
    disabled: disabled.text,
    exactScaleReported: /5\s*\/\s*5/.test(configured.text),
    initialUnsetReported: /未设置|not set/i.test(unset.text),
    disabledUnsetReported: /未设置|not set/i.test(disabled.text),
  };
  // Even synthetic model output must never echo the supplied credential.
  const serialized = JSON.stringify(evidence);
  assert.ok(
    !serialized.includes(key),
    "Provider output attempted to expose a credential; evidence suppressed",
  );
  console.log(serialized);
  assert.ok(
    evidence.exactScaleReported &&
      evidence.initialUnsetReported &&
      evidence.disabledUnsetReported,
    "Real model did not accurately report configured/unset Profile; see synthetic response evidence",
  );
} finally {
  await browser?.close();
  await fixture.close();
}
