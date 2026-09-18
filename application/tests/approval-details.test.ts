import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalDetails } from "../apps/web/src/ApprovalCard.js";

function details(requested: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(ApprovalDetails, {
      approval: {
        requested_at: "2026-09-13T00:00:00Z",
        fingerprint: "a".repeat(64),
        request: {
          approval_id: "approval-details",
          session_id: "fixture-session",
          context_id: "fixture-context",
          justification: "本次授权范围测试",
          action: { kind: "shell", command: "read fixture", cwd: "/fixture" },
          requested,
        },
      },
    }),
  );
}

test("approval summaries retain every known capability and distinguish one-time authorization", () => {
  const html = details({
    network: true,
    read_roots: ["/fixture/read"],
    write_roots: ["/fixture/write"],
    secret_env: ["FIXTURE_TOKEN"],
  });
  for (const expected of [
    "允许联网",
    "读取：/fixture/read",
    "写入：/fixture/write",
    "传入凭据变量：FIXTURE_TOKEN",
    "仅限本次请求，不授予持续权限。",
  ])
    assert.ok(html.includes(expected), expected);
  assert.ok(details({ network: false }).includes("不额外授权联网"));
});

test("unknown or malformed capability fields are shown raw, never summarized as no extra network permission", () => {
  for (const requested of [
    { network: "all" },
    { network: null },
    { read_roots: "/fixture/private" },
    { write_roots: ["/fixture/write", { recursive: true }] },
    { secret_env: [123] },
    { future_capability: true },
  ]) {
    const html = details(requested);
    assert.ok(!html.includes("不额外授权联网"));
    const summary = html.slice(
      html.indexOf("新增权限"),
      html.indexOf('<details class="approval-raw">'),
    );
    for (const key of Object.keys(requested)) assert.ok(summary.includes(key));
  }
});
