import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SentTextQuotes } from "../../apps/web/src/TextQuotes.js";
import type { TextQuote } from "../../packages/core/src/text-quotes.js";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/ui.css";
import "../../apps/web/src/visual-system.css";
import "../../apps/web/src/text-quotes.css";

const text =
  "这种固定消息提醒可以不经过模型求值；只有“到时候查天气，再提醒我是否带伞”这样的动态任务，才需要唤醒 Agent 执行。\n\n" +
  "全文仍然保留，包括第二段和未断行的链接：https://example.invalid/" +
  "long-path-".repeat(40) +
  "\n末尾验证：引用内容没有被截断。";
const quote: TextQuote = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  source: {
    kind: "surface",
    projectId: "test-project",
    title: "Morphz",
  },
  text,
  comment: "就算需要求值，也不一定需要创建一个目标",
};

function Preview() {
  const [appearance, setAppearance] = useState("dark");
  const [accent, setAccent] = useState("teal");
  const [zoom, setZoom] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);
  return (
    <main
      className="app quote-preview-fixture"
      data-appearance={appearance}
      data-accent={accent}
      style={{ display: "block", zoom: zoom ? 2 : 1, overflow: "auto" }}
    >
      <nav
        aria-label="隔离展示控制"
        style={{ display: "flex", gap: 8, padding: 12 }}
      >
        <button
          onClick={() =>
            setAppearance(appearance === "dark" ? "light" : "dark")
          }
        >
          切换明暗
        </button>
        <button onClick={() => setAccent(accent === "teal" ? "mono" : "teal")}>
          切换主题色
        </button>
        <button onClick={() => setZoom(!zoom)}>切换 200% 缩放</button>
      </nav>
      <section
        className="conversation"
        style={{ padding: 12, maxWidth: 720, margin: "auto" }}
      >
        <article
          className="message conversation-message human-message"
          data-fixture="quote-only"
        >
          <SentTextQuotes
            quotes={[quote]}
            onOpen={(q) => setOpened([...opened, q.text])}
          />
          <div className="message-meta">
            <span className="message-peek">10月2日 21:49</span>
          </div>
        </article>
        <article
          className="message conversation-message human-message"
          data-fixture="with-body"
        >
          <SentTextQuotes
            quotes={[quote]}
            onOpen={(q) => setOpened([...opened, q.text])}
          />
          <p>这里有实际正文，引用与正文仍然需要间隔。</p>
          <div className="message-meta">
            <span className="message-peek">10月2日 21:50</span>
          </div>
        </article>
        <article
          className="message conversation-message human-message"
          data-fixture="maximum"
        >
          <SentTextQuotes
            quotes={[
              {
                ...quote,
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                text: "完整长引用。".repeat(4000),
                comment: "",
              },
            ]}
            onOpen={(q) => setOpened([...opened, q.text])}
          />
        </article>
        <output aria-label="原文跳转次数">{opened.length}</output>
        <output aria-label="原文跳转内容" style={{ display: "none" }}>
          {opened.at(-1)}
        </output>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
