import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SafeMarkdown } from "../../apps/web/src/SafeMarkdown.js";
import { initialWorkspace } from "../../packages/core/src/model.js";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/ui.css";
import "../../apps/web/src/visual-system.css";

const source = [
  "# 文档标题",
  "**问题**：第一行\n复现：第二行\n建议：[第三行](https://example.invalid)\n验收：第四行",
  "显式第一行  \n显式第二行\n显式第三行",
  "- 事项第一行\n  事项第二行\n  - 子项第一行\n    子项第二行\n- 列表另项",
  "```text\n代码第一行\n    代码第二行\n```",
].join("\n\n");
const state = initialWorkspace("2026-10-02T13:00:00.000Z");
const quotes = [
  "> TEST 单行引用。\n\n引用外的正文。",
  "> TEST 引用第一段。\n>\n> TEST 引用第二段。",
  "> TEST 外层引用。\n>\n> > TEST 内层引用。",
  "> - TEST 引用中的列表。\n> - TEST 列表第二项。\n>\n> ```text\n> TEST 引用中的代码。\n> ```",
].join("\n\n");

function Preview() {
  const [appended, setAppended] = useState(false);
  return (
    <main
      className="app"
      data-appearance="light"
      style={{ display: "block", overflow: "auto", padding: 16 }}
    >
      <button onClick={() => setAppended(true)}>追加流式正文</button>
      {(["chat", "document"] as const).flatMap((surface) =>
        [false, true].map((streaming) => (
          <section
            key={`${surface}-${streaming}`}
            aria-label={`${surface}-${streaming ? "flow" : "static"}`}
            className={surface === "chat" ? "conversation" : "reader"}
            style={{ width: 560, maxWidth: "100%", margin: "16px auto" }}
          >
            <article
              className="message agent-message"
              style={{ width: "100%", padding: 16 }}
              data-markdown-body
            >
              <SafeMarkdown
                state={state}
                onOpen={() => {}}
                documentTitle={surface === "document" ? "文档标题" : undefined}
                streaming={streaming}
              >
                {streaming && !appended ? "# 文档标题\n\n" : source}
              </SafeMarkdown>
            </article>
          </section>
        )),
      )}
      {(["chat", "document"] as const).flatMap((surface) =>
        [false, true].map((streaming) => (
          <section
            key={`quotes-${surface}-${streaming}`}
            aria-label={`quotes-${surface}-${streaming ? "flow" : "static"}`}
            className={surface === "chat" ? "conversation" : "reader"}
            style={{ width: 560, maxWidth: "100%", margin: "24px auto" }}
          >
            <article
              className={surface === "chat" ? "message agent-reply" : ""}
            >
              <div
                className={
                  surface === "chat" ? "reply-content" : "document-body"
                }
              >
                <SafeMarkdown
                  state={state}
                  onOpen={() => {}}
                  streaming={streaming}
                >
                  {quotes}
                </SafeMarkdown>
              </div>
            </article>
          </section>
        )),
      )}
      <output aria-label="原始 Markdown" hidden>
        {source}
      </output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
