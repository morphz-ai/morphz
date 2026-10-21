import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResponseWaiting } from "../apps/web/src/ResponseWaiting.js";
import { ExecutionProgress } from "../apps/web/src/ExecutionProgress.js";
import {
  conversationDate,
  responseAnswered,
  responseWaitingPresentation,
} from "../apps/web/src/conversation-presentation.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";
import type { Workspace } from "../packages/core/src/model.js";

// These static-markup assertions cover content, not CSS or browser geometry.
// Keep the real component; only make its stylesheet inert in this Node import.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css")
      ? { format: "module", source: "export {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
let SafeMarkdown: typeof import("../apps/web/src/SafeMarkdown.js").SafeMarkdown;
try {
  ({ SafeMarkdown } = await import("../apps/web/src/SafeMarkdown.js"));
} finally {
  styles.deregister();
}

const render = (children: string) =>
  renderToStaticMarkup(
    createElement(SafeMarkdown, {
      children,
      state: { artifacts: [] } as unknown as Workspace,
      onOpen: () => {},
    }),
  );

test("等待区只展示实际模型阶段；新工具和恢复状态按各自时间接替，公开进度精确归属", () => {
  const delivery = {
    inputId: "i",
    state: "running" as const,
    error: null,
    retryable: false,
  };
  const base = {
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "r",
    threadId: "t",
    createdAt: "2026-10-21T00:00:02Z",
  };
  const model = {
    ...base,
    id: "phase",
    text: "",
    kind: "progress" as const,
    modelActivity: "reasoning" as const,
  };
  for (const [phase, label] of [
    ["queued", "模型请求排队中…"],
    ["streaming", "等待模型输出…"],
    ["reasoning", "正在思考…"],
    ["waiting_final_output", "思考完成，等待输出…"],
    ["streaming_text", "正在生成回复…"],
    ["generating_tool_call", "正在准备工具调用…"],
    ["settling", "正在处理响应…"],
  ] as const)
    assert.equal(
      responseWaitingPresentation(
        delivery,
        [{ ...model, modelActivity: phase }],
        true,
      ).label,
      label,
    );
  assert.equal(
    responseWaitingPresentation(delivery, [], true).label,
    "等待回复…",
  );
  assert.equal(
    responseWaitingPresentation(
      delivery,
      [{ ...model, inputId: "other" }],
      true,
    ).label,
    "等待回复…",
  );
  assert.equal(
    responseWaitingPresentation(delivery, [model], false).label,
    "连接中断，等待恢复",
  );
  const tool: LiveMessage = {
    ...base,
    id: "tool",
    kind: "tool",
    text: "",
    createdAt: "2026-10-21T00:00:03Z",
    tool: { name: "read", arguments: "{}", status: "running" },
  };
  assert.equal(
    responseWaitingPresentation(delivery, [model, tool], true).label,
    "正在执行工具…",
  );
  const recovery: LiveMessage = {
    ...base,
    id: "recovery",
    kind: "progress",
    text: "",
    providerRecovery: {
      phase: "waiting",
      reason: "service",
      startedAt: "2026-10-21T00:00:04Z",
    },
  };
  assert.equal(
    responseWaitingPresentation(delivery, [model, tool, recovery], true).label,
    "模型服务暂时中断，自动重试中…",
  );
  assert.equal(
    responseWaitingPresentation(
      delivery,
      [tool, recovery, { ...model, createdAt: "2026-10-21T00:00:05Z" }],
      true,
    ).label,
    "正在思考…",
  );
  const thread = {
    id: "t",
    kind: "execution",
    projectId: "p",
    conversationId: "c",
    inputId: "i",
    rootId: "r",
    sessionId: "s",
    title: "read",
    summary: "正在读取第二章原文",
    annotationProtocol: "on" as const,
    phase: "running",
    lifecycle: "open",
    revision: 1,
    updatedAt: tool.createdAt,
  };
  const activity = { available: true, truncated: false, threads: [thread] };
  assert.equal(
    responseWaitingPresentation(delivery, [tool], true, false, activity).label,
    "正在读取第二章原文",
  );
  for (const changed of [
    { inputId: "other" },
    { id: "other" },
    { rootId: "other" },
    { lifecycle: "completed" },
  ])
    assert.equal(
      responseWaitingPresentation(delivery, [tool], true, false, {
        ...activity,
        threads: [{ ...thread, ...changed }],
      }).label,
      "正在执行工具…",
    );
});

test("只有输入精确关联的持久恢复状态才显示重试；已有前缀不误判完成，终止与正常回复仍清除等待", () => {
  const base = {
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "input-a",
    rootId: "root-a",
    threadId: "thread-a",
    createdAt: "2026-10-13T00:00:00Z",
  };
  const delivery = {
    inputId: "input-a",
    state: "running" as const,
    error: null,
    retryable: false,
  };
  const prefix: LiveMessage = {
    ...base,
    id: "stream:a",
    text: "已显示前缀",
    kind: "reply",
    streaming: false,
    incomplete: true,
  };
  const recovery: LiveMessage = {
    ...base,
    id: "provider_wait_a",
    text: "等待模型服务恢复",
    kind: "progress",
    providerRecovery: {
      startedAt: "2026-10-13T00:00:02Z",
      phase: "waiting",
      reason: "service",
    },
  };
  assert.equal(responseAnswered([prefix, recovery], "input-a"), false);
  assert.equal(
    responseWaitingPresentation(delivery, [prefix, recovery], true).label,
    "模型服务暂时中断，自动重试中…",
  );
  for (const [reason, label] of [
    ["credentials", "模型认证失败，等待修复"],
    ["configuration", "模型配置不可用，等待修复"],
    ["capacity", "模型额度不足，等待处理"],
    ["unknown", "模型服务不可用，等待恢复"],
  ] as const)
    assert.equal(
      responseWaitingPresentation(
        delivery,
        [
          {
            ...recovery,
            providerRecovery: { ...recovery.providerRecovery!, reason },
          },
        ],
        true,
      ).label,
      label,
    );
  assert.equal(
    responseWaitingPresentation(
      { ...delivery, inputId: "input-b" },
      [prefix, recovery],
      true,
    ).label,
    "等待回复…",
  );
  assert.equal(
    responseWaitingPresentation(delivery, [recovery], false).label,
    "连接中断，等待恢复",
  );
  assert.equal(
    responseWaitingPresentation(delivery, [recovery], true, true).label,
    "已请求停止，等待确认",
  );
  const repair = responseWaitingPresentation(
    delivery,
    [
      {
        ...recovery,
        providerRecovery: {
          ...recovery.providerRecovery!,
          reason: "credentials",
        },
      },
    ],
    true,
  );
  assert.deepEqual(repair, {
    label: "模型认证失败，等待修复",
    connected: true,
    animated: false,
    showElapsed: false,
  });
  const markup = renderToStaticMarkup(
    createElement(ResponseWaiting, {
      inputId: delivery.inputId,
      createdAt: base.createdAt,
      ...repair,
    }),
  );
  assert.match(markup, /data-connected="true"/);
  assert.match(markup, /data-animated="false"/);
  assert.doesNotMatch(markup, /response-elapsed/);
  assert.equal(
    responseWaitingPresentation(delivery, [recovery], true).animated,
    true,
  );
  assert.equal(
    responseWaitingPresentation(delivery, [recovery], true).showElapsed,
    true,
  );
  const result: LiveMessage = {
    ...base,
    id: "publication:b",
    text: "重试后的正常回复",
    kind: "reply",
    createdAt: "2026-10-13T00:00:05Z",
  };
  assert.equal(responseAnswered([prefix, recovery, result], "input-a"), true);
  assert.equal(
    responseAnswered(
      [prefix, recovery, { ...result, kind: "error", text: "确实终止" }],
      "input-a",
    ),
    true,
  );
  assert.equal(
    responseAnswered(
      [prefix, recovery, { ...result, inputId: "input-b" }],
      "input-a",
    ),
    false,
  );
  assert.equal(responseAnswered([prefix], "input-a"), true);
  const resumed: LiveMessage = {
    ...base,
    id: "resumed-a",
    kind: "progress",
    text: "",
    createdAt: "2026-10-13T00:00:04Z",
    providerRecovery: {
      startedAt: "2026-10-13T00:00:04Z",
      phase: "resumed",
      reason: "unknown",
    },
  };
  assert.equal(
    responseWaitingPresentation(delivery, [recovery, resumed], true).label,
    "等待回复…",
  );
  assert.equal(
    responseWaitingPresentation(delivery, [resumed, recovery], true).label,
    "等待回复…",
  );
  assert.equal(
    responseWaitingPresentation(
      delivery,
      [recovery, { ...resumed, inputId: "other" }],
      true,
    ).label,
    "模型服务暂时中断，自动重试中…",
  );
  assert.equal(
    responseWaitingPresentation(
      delivery,
      [
        resumed,
        {
          ...recovery,
          providerRecovery: {
            ...recovery.providerRecovery!,
            startedAt: "2026-10-13T00:00:05Z",
            reason: "credentials",
          },
        },
      ],
      true,
    ).label,
    "模型认证失败，等待修复",
  );
});

test("恢复状态不生成空白进展卡片，也不覆盖上一条真实进度", () => {
  const base = {
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "r",
    kind: "progress" as const,
    createdAt: "2026-10-13T00:00:00Z",
  };
  const metadata: LiveMessage = {
    ...base,
    id: "resumed",
    text: "",
    providerRecovery: {
      startedAt: base.createdAt,
      phase: "resumed",
      reason: "unknown",
    },
  };
  assert.equal(
    renderToStaticMarkup(
      createElement(ExecutionProgress, { messages: [metadata], running: true }),
    ),
    "",
  );
  const markup = renderToStaticMarkup(
    createElement(ExecutionProgress, {
      messages: [
        { ...base, id: "actual-progress", text: "已找到实际文件" },
        metadata,
      ],
      running: true,
    }),
  );
  assert.match(markup, /data-progress-id="actual-progress"/);
  assert.doesNotMatch(markup, /data-progress-id="resumed"/);
});

test("日期分隔使用本地日历边界，跨年不混淆，无效时间不伪造日期", () => {
  const date = new Date(2026, 8, 11, 0, 5);
  assert.equal(conversationDate(date.toISOString())?.key, "2026-09-11");
  assert.match(conversationDate(date.toISOString())!.label, /2026.*9.*11/);
  assert.equal(
    conversationDate(new Date(2027, 0, 1).toISOString())?.key,
    "2027-01-01",
  );
  assert.equal(conversationDate("invalid"), null);
});

test("真实中文标点强调与 GFM 表格正确渲染，不改原文", () => {
  const text =
    "是的，截图里**「截图输入」弹窗和灰色遮罩挡住了 PDF**，同时继续。\n\n当天 **上午 9:30（北京时间）**在本会话提醒。\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |";
  const html = render(text);
  assert.match(html, /<strong>「截图输入」弹窗和灰色遮罩挡住了 PDF<\/strong>/);
  assert.match(html, /<strong>上午 9:30（北京时间）<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>完成<\/td>/);
  assert.match(html, /aria-label="表格"/);
  assert.ok(text.includes("**"));
});

test("代码、转义与未完成流片段不被正则改写，HTML 和远程图片仍不可执行", () => {
  assert.match(
    render("`中文**「原样」**保留`"),
    /<code>中文\*\*「原样」\*\*保留<\/code>/,
  );
  assert.match(render("```txt\n**不处理。**\n```"), /\*\*不处理。\*\*/);
  assert.match(render("\\*\\*字面星号\\*\\*"), /\*\*字面星号\*\*/);
  assert.match(render("中文**「未完成"), /中文\*\*「未完成/);
  const html = render(
    "<script>alert(1)</script>\n\n![外图](https://example.com/private.png)\n\n[危险](javascript:alert(1))",
  );
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.match(html, /查看外部图片/);
});
