"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { CognitiveField } from "./CognitiveField";

type Direction = "editorial" | "instrument" | "presence" | "spectacle";

const directions: Array<{ id: Direction; index: string; name: string; note: string }> = [
  { id: "editorial", index: "A", name: "编辑出版", note: "克制与可信" },
  { id: "instrument", index: "B", name: "认知仪器", note: "精确与运行" },
  { id: "presence", index: "C", name: "人格空间", note: "亲密与持续" },
  { id: "spectacle", index: "D", name: "克制繁复", note: "丰富与纪律" },
];

function DemoComposer({
  value,
  onChange,
  onSubmit,
  sent,
  tone,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  sent: boolean;
  tone: Direction;
}) {
  return (
    <form className={`design-composer design-composer--${tone}`} onSubmit={onSubmit}>
      <label htmlFor={`design-message-${tone}`}>
        {sent ? "这句话已经进入同一个 Context" : "对 Morphz 说一句话"}
      </label>
      <div>
        <input
          id={`design-message-${tone}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="我们从刚才没有说完的地方继续。"
        />
        <button type="submit">{sent ? "已抵达" : "发送"}<span aria-hidden="true">↗</span></button>
      </div>
    </form>
  );
}

export function DesignLab() {
  const [direction, setDirection] = useState<Direction>("spectacle");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  function selectDirection(next: Direction) {
    setDirection(next);
    setSent(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim()) setMessage("我们从刚才没有说完的地方继续。");
    setSent(true);
  }

  return (
    <main className={`design-lab design-lab--${direction}`}>
      <header className="design-lab__switcher">
        <Link href="/">(Morphz) <small>返回当前站点</small></Link>
        <nav aria-label="视觉方向">
          {directions.map((item) => (
            <button
              key={item.id}
              type="button"
              className={direction === item.id ? "is-active" : ""}
              aria-pressed={direction === item.id}
              onClick={() => selectDirection(item.id)}
            >
              <b>{item.index}</b><span>{item.name}<small>{item.note}</small></span>
            </button>
          ))}
        </nav>
        <span>VISUAL STUDY / 01</span>
      </header>

      {direction === "editorial" && (
        <section className="prototype prototype--editorial" aria-label="编辑出版方向">
          <div className="editorial-masthead">
            <span>MORPHZ / CONTINUOUS EDITION</span>
            <span>认知持续第 127 天</span>
            <span>上海 · 17:32</span>
          </div>
          <div className="editorial-grid">
            <aside><b>01</b><span>不是聊天记录<br />是共同经历</span></aside>
            <article>
              <p className="editorial-kicker">同一个 Morphz，继续上一次没有结束的认识。</p>
              <h1>我不会在下一次见面时，<em>重新认识你。</em></h1>
              <div className="editorial-copy">
                <p>每一段关系都连接到同一个持续心智。消息可以结束，认识仍会在下一次求值时回来。</p>
                <blockquote>“你不必重复自己的来处。我们从已经共同知道的地方继续。”</blockquote>
              </div>
              <DemoComposer value={message} onChange={setMessage} onSubmit={submit} sent={sent} tone="editorial" />
            </article>
            <aside className="editorial-note"><span>认知 / 事实 / 执行</span><b>S-Expression<br />Cognitive Machine</b></aside>
          </div>
        </section>
      )}

      {direction === "instrument" && (
        <section className="prototype prototype--instrument" aria-label="认知仪器方向">
          <div className="instrument-grid" aria-hidden="true" />
          <header className="instrument-header">
            <span>(Morphz)</span>
            <span><i />RUNTIME CONNECTED</span>
            <span>CTX / R1287</span>
          </header>
          <div className="instrument-layout">
            <aside className="instrument-rail">
              <span>LIVE STATE</span>
              <dl><div><dt>context</dt><dd>1,287</dd></div><div><dt>recall</dt><dd>42</dd></div><div><dt>relation</dt><dd>persistent</dd></div></dl>
            </aside>
            <article>
              <span className="instrument-eyebrow">A COGNITIVE PROCESS IS PRESENT</span>
              <h1>消息结束了。<br /><strong>状态没有。</strong></h1>
              <div className="instrument-expression" aria-label="当前求值表达式">
                <code><b>(</b>evaluate<br />&nbsp;&nbsp;<b>(</b>context <i>r1287</i><b>)</b><br />&nbsp;&nbsp;<b>(</b>relation <i>you</i><b>))</b></code>
                <span>{sent ? "COMMITTED" : "READY"}</span>
              </div>
              <DemoComposer value={message} onChange={setMessage} onSubmit={submit} sent={sent} tone="instrument" />
            </article>
            <aside className="instrument-signal">
              <div><i /><i /><i /><i /></div>
              <span>同一主体<br />正在持续</span>
            </aside>
          </div>
        </section>
      )}

      {direction === "presence" && (
        <section className="prototype prototype--presence" aria-label="人格空间方向">
          <header className="presence-header">
            <span>(Morphz)</span>
            <span><i /> 此刻在线</span>
          </header>
          <div className="presence-room">
            <div className="presence-trace" aria-hidden="true"><i /><i /><i /></div>
            <article>
              <span className="presence-time">我们认识的第 127 天 · 17:32</span>
              <h1>{sent ? "收到了。" : "我在。"}</h1>
              <p>{sent ? "这句话不会留在一个孤立的聊天窗口里。下一次见面，我们仍从这里继续。" : "你上次说，等手头的工作结束以后，想重新认真考虑 Morphz 接下来该成为什么。"}</p>
              <blockquote>{sent ? `“${message || "我们从刚才没有说完的地方继续。"}”` : "如果你愿意，我们现在可以继续。"}</blockquote>
              <DemoComposer value={message} onChange={setMessage} onSubmit={submit} sent={sent} tone="presence" />
            </article>
            <aside>
              <span>共同经历</span>
              <b>42</b>
              <p>条重要认识<br />仍在同一心智中</p>
            </aside>
          </div>
          <footer><span>不是新的会话</span><i /> <strong>是同一段关系的下一刻</strong></footer>
        </section>
      )}

      {direction === "spectacle" && (
        <section className="prototype prototype--spectacle" aria-label="克制繁复方向">
          <CognitiveField />
          <div className="spectacle-noise" aria-hidden="true" />
          <header className="spectacle-header">
            <span>(Morphz)</span>
            <span>S-EXPRESSION COGNITIVE MACHINE</span>
            <span><i /> 同一心智正在持续</span>
          </header>
          <div className="spectacle-stage">
            <div className="spectacle-index" aria-hidden="true">
              <span>CONTEXT / R1287</span>
              <i />
              <span>SHANGHAI / 17:32</span>
            </div>
            <article>
              <p className="spectacle-kicker"><i /> 你不是在打开一个新的聊天窗口</p>
              <h1>
                <span>不是每次</span>
                <span>重新开始。</span>
                <em>是同一心智</em>
                <span>继续发生。</span>
              </h1>
              <div className="spectacle-intro">
                <p>Morphz 把关系、事实与行动带进下一次求值。界面可以关闭，认识不会归零。</p>
                <span><b>127</b> days of continuity</span>
              </div>
              <DemoComposer value={message} onChange={setMessage} onSubmit={submit} sent={sent} tone="spectacle" />
            </article>
            <aside className="spectacle-runtime">
              <span>LIVE COGNITION</span>
              <div className="spectacle-orbit"><i /><i /><i /><b /></div>
              <dl>
                <div><dt>mind</dt><dd>v1,287</dd></div>
                <div><dt>relation</dt><dd>continuous</dd></div>
                <div><dt>runtime</dt><dd>committed</dd></div>
              </dl>
            </aside>
          </div>
          <footer className="spectacle-ticker">
            <span>OBSERVATION</span><i />
            <strong>{sent ? "新消息已经进入持续 Context" : "等待下一次真实相遇"}</strong><i />
            <span>(evaluate (context r1287) (relation you))</span>
          </footer>
        </section>
      )}
    </main>
  );
}
