/** Explicit opt-in usage of an already configured model through a trusted local
 * proxy. Synthetic UI inputs only, fresh Host/Runtime DBs, no original Profile
 * or history. Provider key comes solely from this process's dedicated env var;
 * no credential discovery, login, configuration mutation or secret output. */
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "@playwright/test";
import { profileActualTransportFixture } from "../tests/profile-actual-transport-fixture.js";
import { defaultAgentProfile } from "../packages/core/src/profile.js";
import { openInput } from "../tests/interaction-helpers.js";

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
  realProvider: { key, model, baseUrl, protocol, maximumCalls: 2 },
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
  const input = await openInput(page);
  await input.fill(
    marker +
      "：你叫什么名字？只按当前已安装的只读 Profile 回答；未设置就说明未设置名字，不推测姓名。只用一句话，不调用工具。",
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
  const panel = page.locator(".subject-sidebar");
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "设定", exact: true }).click();
  const editor = panel.getByRole("region", { name: "智能体资料", exact: true });
  await editor
    .getByRole("checkbox", { name: "设置智能体名字", exact: true })
    .check();
  await editor
    .getByRole("textbox", { name: "智能体的名字", exact: true })
    .fill("Echo");
  // No Save click, Enter in the Profile field, or debounce delay. The actual
  // App send path must flush the edited Profile before Runtime admits input.
  const configured = await ask(page, "TEST_PROFILE_LIVE_IMMEDIATE_NAME");
  const actual = await fixture.read();
  assert.equal(actual.agent.data.name, "Echo");
  assert.equal(actual.agent.enabled, true);
  assert.ok(configured.messages.includes("(name Echo)"));
  assert.match(configured.text, /\bEcho\b/i);
  const sessions = fixture.sql<{ id: string }>("SELECT id FROM sessions");
  assert.equal(sessions.length, 1);
  await editor
    .getByRole("checkbox", { name: "使用 Profile", exact: true })
    .uncheck();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await fixture.read()).agent.enabled) break;
    await pause(50);
  }
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
  assert.deepEqual(fixture.sql("SELECT id FROM sessions"), sessions);
  // Only synthetic identity answers; no original Profile or conversation.
  const evidence = {
    realModel: true,
    realUiHostRust: true,
    model,
    provider: endpoint.origin,
    requests: fixture.realCalls,
    sameSession: true,
    configured: configured.text,
    disabled: disabled.text,
    profileNameReported: /\bEcho\b/i.test(configured.text),
    disabledRomAbsent: !disabled.messages.includes("(agent-profile "),
  };
  // Even synthetic model output must never echo the supplied credential.
  const serialized = JSON.stringify(evidence);
  assert.ok(
    !serialized.includes(key),
    "Provider output attempted to expose a credential; evidence suppressed",
  );
  console.log(serialized);
  assert.ok(
    evidence.profileNameReported && evidence.disabledRomAbsent,
    "Real model identity or disabled ROM verification failed",
  );
} finally {
  await browser?.close();
  await fixture.close();
}
