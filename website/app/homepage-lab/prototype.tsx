"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { SITE_LINKS } from "@/lib/site";
import { BrandMark } from "../components/BrandMark";
import { ThemeToggle } from "../components/ThemeToggle";
import { ButterflyArrival } from "../components/ButterflyArrival";
import { ProjectHome, ProjectFooter } from "./project-home";

type Variant = "a" | "b" | "c";
type Screen = "home" | "workspace" | "persona";
type Modal = "login" | "create" | "provider" | "video" | null;
type Message = { author: "user" | "agent"; text: string };

const variants = [
  { id: "a", title: "技术项目优先", detail: "先看实现，再选择使用方式" },
  { id: "b", title: "技术 × 使用", detail: "技术主张与三个真实意图并排" },
  { id: "c", title: "工作入口优先", detail: "先输入任务，技术内容留在同页" },
] as const;

const install = "curl -fsSL https://morphz.ai/install.sh | sh -s -- setup";
const prompts = ["帮我研究一个技术方案", "一起推进我的开源项目", "整理我这周的工作"];

function Mark({ size = 29 }: { size?: number }) {
  return <Image src="/brand/morphz-mark-cyan.svg" alt="" width={size} height={size} unoptimized />;
}

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <span className="hp-arrow" aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
}

function GithubMark() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.74.4-1.24.72-1.53-2.5-.28-5.13-1.25-5.13-5.58 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.99 0 0 .95-.3 3.08 1.16a10.68 10.68 0 0 1 5.6 0c2.14-1.46 3.08-1.16 3.08-1.16.62 1.56.23 2.71.12 2.99.72.79 1.15 1.8 1.15 3.03 0 4.34-2.64 5.3-5.15 5.58.4.35.76 1.04.76 2.1v3.08c0 .3.2.65.78.54A11.2 11.2 0 0 0 12 .8Z" /></svg>;
}

function TechnicalExplorer({ compact = false }: { compact?: boolean }) {
  const [selected, setSelected] = useState<"context" | "concurrency" | "targets">("context");
  return (
    <section className={`hp-explorer${compact ? " hp-explorer--compact" : ""}`} aria-label="Morphz 技术结构示意">
      <div className="hp-explorer-bar"><span><i /> Morphz 运行时</span><small>结构示意</small></div>
      <div className="hp-explorer-tabs" role="group" aria-label="查看运行机制">
        <button aria-pressed={selected === "context"} onClick={() => setSelected("context")}>认知上下文</button>
        <button aria-pressed={selected === "concurrency"} onClick={() => setSelected("concurrency")}>并发求值</button>
        <button aria-pressed={selected === "targets"} onClick={() => setSelected("targets")}>执行节点</button>
      </div>
      <div className="hp-explorer-content">
        {selected === "context" && <>
          <div className="hp-tree" aria-label="上下文包含认知帧、会话与内核状态">
            <span className="hp-tree-root">▾ 认知上下文</span>
            <div className="hp-tree-branch"><span>▾ 认知帧</span><em>项目约束</em><em>技术决策</em></div>
            <div className="hp-tree-branch"><span>▾ 会话</span><em>网页对话</em><em>微信对话</em></div>
            <div className="hp-tree-branch"><span>▾ 内核状态</span><em>目标 · 线程 · 执行状态</em></div>
          </div>
          <div className="hp-frame-detail">
            <span className="hp-code-caption">认知帧</span><h3>技术决策</h3>
            <p>当前方案与它背后的理由，成为可以持续修订的认知。</p>
            <div className="hp-frame-revision"><span>版本 n</span><b>修订</b><span>版本 n+1</span></div>
            <code>derive · revise · retire · restore</code>
          </div>
        </>}
        {selected === "concurrency" && <div className="hp-lanes">
          <span className="hp-code-caption">一个智能体，多条工作线</span>
          <div><span>研究方案</span><b>求值</b><i>工具执行</i><b>继续求值</b></div>
          <div><span>修改代码</span><b>求值</b><i>测试</i><b>继续求值</b></div>
          <div><span>新的对话</span><b>求值</b><b>回复</b></div>
          <p>工具等待期间，其他工作线仍可推进。认知修改经过事务与版本校验。</p>
        </div>}
        {selected === "targets" && <div className="hp-target-map">
          <span className="hp-code-caption">认知求值与执行分离</span>
          <div className="hp-target-core"><Mark size={24} /><b>Morphz 运行时</b><small>认知求值 · 调度 · 权限</small></div>
          <div className="hp-target-nodes"><span>本机</span><span>远程主机</span><span>边缘节点</span></div>
          <p>任务到达资源所在的位置。每个执行节点都有明确的能力与权限边界。</p>
        </div>}
      </div>
      <footer><span>结构化认知 · 显式事务 · 持久调度</span><a href="/docs/core-concepts" target="_blank" rel="noreferrer">阅读设计 <Arrow /></a></footer>
    </section>
  );
}

function InstallBlock() {
  const [platform, setPlatform] = useState<"unix" | "windows">("unix");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const command = platform === "unix" ? install : "irm https://morphz.ai/install.ps1 | iex\nmorphz setup";
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  }
  return <div className="hp-install" id="local-install">
    <header><span>在自己的机器上运行</span><div role="group" aria-label="安装平台">
      <button aria-pressed={platform === "unix"} onClick={() => { setPlatform("unix"); setCopied(false); }}>macOS / Linux</button>
      <button aria-pressed={platform === "windows"} onClick={() => { setPlatform("windows"); setCopied(false); }}>Windows</button>
    </div></header>
    <div><code>{command}</code><button onClick={() => void copy()} aria-label="复制安装命令">{copied ? "已复制" : "复制"}</button></div>
    {copyFailed && <p role="status">浏览器未允许复制，请选择上方命令手动复制。</p>}
  </div>;
}

function EvidenceLinks({ onVideo }: { onVideo: () => void }) {
  return <section className="hp-evidence" id="technical-evidence" aria-label="技术资料">
    <div className="hp-section-intro"><span className="hp-kicker">BUILT IN THE OPEN</span><h2>从机制到实现，都有迹可循。</h2><p>读设计、看实机运行，也可以直接检查源码。</p></div>
    <div className="hp-evidence-grid">
      <a href="/paper" target="_blank" rel="noreferrer"><span>01 / RESEARCH</span><h3>论文与评测 <Arrow diagonal /></h3><p>结构化上下文求值的研究、实验与边界。</p></a>
      <a href="/docs" target="_blank" rel="noreferrer"><span>02 / DOCUMENTATION</span><h3>文档与架构 <Arrow diagonal /></h3><p>理解认知上下文、并发调度和执行节点。</p></a>
      <a href={SITE_LINKS.source} target="_blank" rel="noreferrer"><span>03 / SOURCE</span><h3>源码与测试 <Arrow diagonal /></h3><p>Apache-2.0 开源，直接进入实现。</p></a>
      <button onClick={onVideo}><span>04 / IN ACTION</span><h3>实机演示 <Arrow /></h3><p>一个智能体，四线程构建微缩北京。</p></button>
    </div>
  </section>;
}

type HomeActions = { onCreate: () => void; onPersona: () => void; onVideo: () => void; created: boolean };

function PlatformHome({ onCreate, onPersona, onVideo, created }: HomeActions) {
  return <>
    <section className="hp-platform-hero hp-width">
      <div className="hp-hero-copy"><span className="hp-kicker"><i /> OPEN SOURCE · STRUCTURED COGNITION</span><h1>一个智能体。<br />多个目标。<br /><em>并发推进。</em></h1>
        <p>Morphz 将结构化认知、并发求值与分布式执行，组织在同一个智能体运行时 中。</p>
        <div className="hp-mechanism-tags"><span>Context DB</span><span>Concurrent Evaluation</span><span>Edge Nodes</span></div>
        <div className="hp-text-links"><a href={SITE_LINKS.source} target="_blank" rel="noreferrer"><GithubMark /> Apache-2.0 / 源码</a><a href="/paper" target="_blank" rel="noreferrer">论文与评测 <Arrow diagonal /></a></div>
      </div>
      <section className="hp-start-panel" aria-label="开始使用 Morphz"><header><Mark size={24} /><span>从这里开始</span></header>
        <div className="hp-start-primary"><span className="hp-mini-label">YOUR OWN AGENT</span><h2>让你的智能体<br />开始工作。</h2><p>登录后创建。拥有独立的认知、会话和工作空间。</p><button className="hp-button hp-primary" onClick={onCreate}>{created ? "进入我的智能体" : "创建自己的智能体"} <Arrow /></button><small>连接你自己的模型服务</small></div>
        <button className="hp-entry-row" onClick={onPersona}><span className="hp-entry-icon"><Mark size={20} /></span><span><strong>与 Morphz 对话</strong><small>认识官方智能体 · 共享认知</small></span><Arrow /></button>
        <a className="hp-entry-row" href="#local-install"><span className="hp-entry-icon hp-terminal-glyph">&gt;_</span><span><strong>在本地运行</strong><small>开源 Runtime · 数据留在自己的节点</small></span><Arrow /></a>
      </section>
    </section>
    <section className="hp-mechanism-section hp-width"><div className="hp-mechanism-heading"><div><span className="hp-kicker">THE RUNTIME, UNDERNEATH</span><h2>同一个内核，贯穿每一种使用方式。</h2></div><a className="hp-inline-link" href="/docs" target="_blank" rel="noreferrer">深入架构 <Arrow diagonal /></a></div><TechnicalExplorer compact /></section>
    <div className="hp-width"><EvidenceLinks onVideo={onVideo} /><InstallBlock /></div>
  </>;
}

function WorkHome({ onCreate, onPersona, onVideo, created, draft, setDraft, personaDraft, setPersonaDraft }: HomeActions & { draft: string; setDraft: (draft: string) => void; personaDraft: string; setPersonaDraft: (draft: string) => void }) {
  const [mode, setMode] = useState<"private" | "public">("private");
  const currentDraft = mode === "private" ? draft : personaDraft;
  const changeDraft = mode === "private" ? setDraft : setPersonaDraft;
  function submit(event: FormEvent) { event.preventDefault(); if (mode === "public") onPersona(); else onCreate(); }
  return <>
    <section className="hp-work-hero hp-width">
      <aside className="hp-work-index"><span className="hp-kicker">MORPHZ / OPEN SOURCE</span><h2>一个内核。<br />持续的认知。</h2><p>结构化上下文<br />多路并发求值<br />分布式执行</p><a href="/docs" target="_blank" rel="noreferrer">阅读文档 <Arrow diagonal /></a><a href={SITE_LINKS.source} target="_blank" rel="noreferrer"><GithubMark /> 查看源码</a><button onClick={onVideo}>观看实机演示 <Arrow /></button></aside>
      <div className="hp-work-start"><div className="hp-work-brand"><Mark size={44} /></div><h1>一个智能体。多个目标。<br /><em>并发推进。</em></h1>
        <div className="hp-mode-switch" role="group" aria-label="选择对话对象"><button aria-pressed={mode === "private"} onClick={() => setMode("private")}>我的智能体</button><button aria-pressed={mode === "public"} onClick={() => setMode("public")}>官方 Morphz</button></div>
        <form className="hp-composer hp-start-composer" onSubmit={submit}><label className="hp-sr-only" htmlFor="home-task">告诉智能体你想做什么</label><textarea id="home-task" value={currentDraft} onChange={(event) => changeDraft(event.target.value)} placeholder={mode === "private" ? "你想和自己的智能体一起做什么？" : "想问 Morphz 什么？"} rows={3} /><footer><span>{mode === "private" ? "独立认知 · 独立工作空间" : "官方智能体 · 共享认知"}</span><button type="submit" className="hp-button hp-primary">{mode === "private" ? created ? "进入我的智能体" : "开始工作" : "开始对话"} <Arrow /></button></footer></form>
        <div className="hp-prompt-list">{(mode === "private" ? prompts : ["你是如何持续学习的？", "给我讲讲你的上下文数据库"]).map((prompt) => <button key={prompt} onClick={() => changeDraft(prompt)}>{prompt} <span aria-hidden="true">↗</span></button>)}</div>
        <p className="hp-work-entry-note">{mode === "private" ? "登录后创建自己的智能体，刚才输入的任务会为你保留。" : "不同人的对话可能进入共享认知，请勿发送私人信息。"}</p>
      </div>
    </section>
    <section className="hp-work-underlay hp-width"><div><span className="hp-kicker">BEYOND THE CHAT WINDOW</span><h2>对话只是入口，<br />认知在持续工作。</h2><p>查看认知上下文、并发工作线与执行节点如何连接。</p></div><TechnicalExplorer compact /></section>
    <div className="hp-width"><EvidenceLinks onVideo={onVideo} /><InstallBlock /></div>
  </>;
}

export function HomepagePrototype({ variant }: { variant: Variant }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [loggedIn, setLoggedIn] = useState(false);
  const [created, setCreated] = useState(false);
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("我的智能体");
  const [draft, setDraft] = useState("");
  const [personaDraft, setPersonaDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [publicMessages, setPublicMessages] = useState<Message[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [afterLogin, setAfterLogin] = useState<"home" | "create" | "persona">("home");
  const [model, setModel] = useState("Codex");
  const [workspaceTab, setWorkspaceTab] = useState<"chat" | "context" | "devices">("chat");
  const [activeMenu, setActiveMenu] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const workspaceHeading = useRef<HTMLHeadingElement>(null);

  function goHome() {
    setScreen("home");
    setActiveMenu(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  useEffect(() => {
    const element = dialog.current;
    if (modal && element && !element.open) element.showModal();
    if (!modal && element?.open) element.close();
  }, [modal]);

  useEffect(() => {
    if (screen !== "home") { workspaceHeading.current?.focus(); window.scrollTo({ top: 0, behavior: "instant" }); }
  }, [screen]);

  function createEntry() {
    if (!loggedIn) { setAfterLogin("create"); setModal("login"); return; }
    if (created) { setWorkspaceTab("chat"); setScreen("workspace"); return; }
    setModal("create");
  }

  function login() {
    setLoggedIn(true);
    if (afterLogin === "create" && created) { setModal(null); setScreen("workspace"); }
    else if (afterLogin === "create") setModal("create");
    else { setModal(null); if (afterLogin === "persona") setScreen("persona"); }
  }

  function reset() {
    goHome(); setLoggedIn(false); setCreated(false); setConnected(false); setName("我的智能体");
    setMessages([]); setPublicMessages([]); setDraft(""); setPersonaDraft(""); setModal(null); setWorkspaceTab("chat"); setActiveMenu(false);
  }

  function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setName(name.trim()); setCreated(true); setModal(null); setScreen("workspace"); setWorkspaceTab("chat");
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const sendingDraft = screen === "persona" ? personaDraft : draft;
    if (!sendingDraft.trim()) return;
    if (!loggedIn) { setAfterLogin("persona"); setModal("login"); return; }
    if (screen === "workspace" && !connected) { setModal("provider"); return; }
    const additions: Message[] = [{ author: "user", text: sendingDraft.trim() }, { author: "agent", text: screen === "persona" ? "你好，我是官方 Morphz。这是对话界面的示例回复；正式接入后，我们会在这里交流。" : "收到。这是工作空间的示例回复，正式接入后，任务会交给你的智能体处理。" }];
    if (screen === "persona") setPublicMessages((previous) => [...previous, ...additions]);
    else setMessages((previous) => [...previous, ...additions]);
    if (screen === "persona") setPersonaDraft(""); else setDraft("");
  }

  const actions: HomeActions = { onCreate: createEntry, onPersona: () => setScreen("persona"), onVideo: () => setModal("video"), created };
  const currentMessages = screen === "persona" ? publicMessages : messages;
  const activeDraft = screen === "persona" ? personaDraft : draft;
  const loginDraft = afterLogin === "persona" ? personaDraft : afterLogin === "create" ? draft : "";
  const changeActiveDraft = screen === "persona" ? setPersonaDraft : setDraft;

  return <div className={`hp-lab hp-theme-${variant}`}>
    <div className="hp-lab-toolbar"><div className="hp-lab-toolbar-inner"><span className="hp-lab-label">本地预览</span><nav aria-label="切换首页方案">{variants.map((item) => <a href={`/homepage-lab/${item.id}`} key={item.id} aria-current={item.id === variant ? "page" : undefined} title={item.detail}><b>{item.id.toUpperCase()}</b><span>{item.title}</span></a>)}</nav><a className="hp-compare-original" href="/" target="_blank" rel="noreferrer">对照原首页 ↗</a><button onClick={reset}>重置演示</button></div><p>交互原型 · 登录、创建与回复均为本地演示，不连接真实账户服务</p></div>

    <header className={`hp-header${variant === "a" ? " site-header" : ""}`}>
      <div className="hp-width hp-header-inner">
        <button className="hp-brand brand" onClick={goHome} aria-label="Morphz 原型首页">{variant === "a" ? <BrandMark /> : <Mark />}<strong>Morphz</strong></button>
        <nav aria-label="网站导航"><a href="/docs" target="_blank" rel="noreferrer">文档</a><a href="/paper" target="_blank" rel="noreferrer">论文</a><a href="/standards" target="_blank" rel="noreferrer">规范</a><a href={SITE_LINKS.source} target="_blank" rel="noreferrer"><GithubMark /> GitHub</a></nav>
        <div className="hp-account-actions">
          {variant === "a" && <ThemeToggle label="切换明暗主题" />}
          {loggedIn ? <><button className="hp-login" onClick={() => setActiveMenu(!activeMenu)} aria-label="演示账户菜单" aria-expanded={activeMenu}>M <span>演示账户</span></button>{activeMenu && <div className="hp-account-menu"><span>仅当前页面的演示身份</span><button onClick={() => { setLoggedIn(false); goHome(); }}>退出登录</button></div>}</> : <button className="hp-login" onClick={() => { setAfterLogin("home"); setModal("login"); }}>登录</button>}
          <button className="hp-button hp-primary hp-nav-create" onClick={createEntry}>{created ? "我的智能体" : "创建智能体"} <Arrow /></button>
        </div>
      </div>
    </header>
    {variant === "a" && screen === "home" && <ButterflyArrival locale="zh" />}

    {screen === "home" ? <main>{variant === "a" ? <ProjectHome {...actions} explorer={<TechnicalExplorer />} install={<InstallBlock />} /> : variant === "b" ? <PlatformHome {...actions} /> : <WorkHome {...actions} draft={draft} setDraft={setDraft} personaDraft={personaDraft} setPersonaDraft={setPersonaDraft} />}</main> : <main className="hp-workspace hp-width">
      <div className="hp-workspace-location"><button onClick={goHome}>← 官网首页</button><span>/</span><span>{screen === "persona" ? "官方 Morphz" : "我的智能体"}</span></div>
      <div className="hp-workspace-shell"><aside className="hp-workspace-sidebar"><div className="hp-workspace-identity"><Mark size={24} /><div><strong>{screen === "persona" ? "Morphz" : name}</strong><small>{screen === "persona" ? "官方智能体 · 共享认知" : "独立智能体 · 私有工作空间"}</small></div></div>
        <button className={workspaceTab === "chat" || screen === "persona" ? "is-active" : ""} onClick={() => setWorkspaceTab("chat")}>对话 <span>↗</span></button>{screen === "workspace" && <><button className={workspaceTab === "context" ? "is-active" : ""} onClick={() => setWorkspaceTab("context")}>认知</button><button className={workspaceTab === "devices" ? "is-active" : ""} onClick={() => setWorkspaceTab("devices")}>执行节点</button></>}
        <div className="hp-workspace-sidebar-bottom">{screen === "workspace" ? <><span>模型连接</span><button onClick={() => setModal("provider")}>{connected ? `${model} · 示例连接` : "尚未连接模型"} <span>↗</span></button><button onClick={() => setScreen("persona")}>与官方 Morphz 对话 <Arrow /></button></> : <button onClick={createEntry}>创建自己的智能体 <Arrow /></button>}</div>
      </aside>
      <section className="hp-workspace-main"><header><h1 ref={workspaceHeading} tabIndex={-1}>{screen === "persona" ? "与 Morphz 对话" : workspaceTab === "context" ? "认知" : workspaceTab === "devices" ? "执行节点" : name}</h1><span>{screen === "persona" ? "官方智能体" : "仅你可见"}</span></header>
        {screen === "workspace" && workspaceTab === "context" ? <div className="hp-workspace-detail"><span className="hp-kicker">认知</span><h2>认知会随着工作积累。</h2><p>你的智能体可以从对话与工作中维护认知帧，并在新证据出现时修订它们。</p><TechnicalExplorer /></div> : screen === "workspace" && workspaceTab === "devices" ? <div className="hp-workspace-detail"><span className="hp-kicker">执行节点</span><h2>把工作连接到自己的节点。</h2><p>先完成模型接入，再按需连接本机或远程主机。创建智能体时不必一次配置完。</p><a className="hp-button" href="/docs/execution-targets" target="_blank" rel="noreferrer">查看接入文档 <Arrow diagonal /></a></div> : <>
          {screen === "persona" && <div className="hp-public-boundary">这是官方共享智能体。对话可能进入共享认知，请勿发送私人信息。</div>}
          <div className="hp-conversation" aria-live="polite">{currentMessages.length ? currentMessages.map((message, index) => <div key={index} className={`hp-message hp-message--${message.author}`}><span>{message.author === "user" ? "你" : `${screen === "persona" ? "Morphz" : name} · 示例回复`}</span><p>{message.text}</p></div>) : <div className="hp-empty-work"><Mark size={44} /><h2>{screen === "persona" ? "你好，我是 Morphz。" : connected ? "我们从哪件事开始？" : `${name}，已创建。`}</h2><p>{screen === "persona" ? "可以聊聊结构化认知、并发工作，或者你正在做的项目。" : connected ? "告诉我你的目标，我们一起把它向前推进。" : "下一步连接模型。会话和工作内容属于这个独立智能体。"}</p>{screen === "workspace" && !connected ? <button className="hp-button hp-primary" onClick={() => setModal("provider")}>连接模型 <Arrow /></button> : <div className="hp-prompt-list">{(screen === "persona" ? ["你和普通聊天助手有什么不同？", "给我讲讲你的上下文数据库"] : prompts).map((prompt) => <button onClick={() => changeActiveDraft(prompt)} key={prompt}>{prompt} <Arrow /></button>)}</div>}</div>}</div>
          <form className="hp-composer hp-workspace-composer" onSubmit={send}><label className="hp-sr-only" htmlFor="workspace-message">消息</label><textarea id="workspace-message" value={activeDraft} onChange={(event) => changeActiveDraft(event.target.value)} placeholder={screen === "persona" ? "和 Morphz 聊聊……" : "告诉智能体你想做什么……"} rows={2} /><footer><span>{screen === "persona" ? "官方共享认知" : connected ? `${model} · 示例连接` : "连接模型后即可开始"}</span><button className="hp-button hp-primary" disabled={!activeDraft.trim()}>{!loggedIn ? "登录后发送" : "发送"} <Arrow /></button></footer></form>
        </>}
      </section></div>
    </main>}

    {variant === "a" && screen === "home" ? <ProjectFooter {...actions} /> : <footer className="hp-footer hp-width"><span><Mark size={20} /> Morphz <small>开源认知运行时</small></span><div><a href="/docs" target="_blank" rel="noreferrer">文档</a><a href={SITE_LINKS.source} target="_blank" rel="noreferrer">GitHub</a><a href="/" target="_blank" rel="noreferrer">对照当前官网 <Arrow diagonal /></a></div></footer>}

    <dialog ref={dialog} aria-label={modal === "login" ? "登录 Morphz" : modal === "create" ? "创建智能体" : modal === "provider" ? "连接模型" : "实机演示"} className={`hp-dialog${modal === "video" ? " hp-dialog--video" : ""}`} onCancel={() => setModal(null)} onClose={() => setModal(null)}><button className="hp-dialog-close" onClick={() => setModal(null)} aria-label="关闭弹窗">×</button>
      {modal === "login" && <div className="hp-dialog-content"><Mark size={38} /><span className="hp-kicker">你的工作空间</span><h2>登录 Morphz</h2><p>{afterLogin === "create" ? created ? "登录后，继续和自己的智能体工作。" : "接下来创建属于你的智能体。" : "回到自己的智能体，也可以与官方 Morphz 交流。"}</p><button className="hp-button hp-auth-button" onClick={login}><GithubMark /> 使用 GitHub 继续 <Arrow /></button><small className="hp-demo-note">演示登录：不会跳转授权或读取你的 GitHub 账号。</small>{loginDraft && <div className="hp-preserved-draft">已保留你的输入：<span>{loginDraft}</span></div>}</div>}
      {modal === "create" && <form className="hp-dialog-content" onSubmit={create}><Mark size={38} /><span className="hp-kicker">我的智能体</span><h2>{created ? "进入你的智能体" : "创建自己的智能体"}</h2><p>独立认知、独立会话，和官方 Morphz 分开。</p>{created ? <button className="hp-button hp-primary hp-full" onClick={() => { setModal(null); setScreen("workspace"); }} type="button">进入 {name} <Arrow /></button> : <><label className="hp-field-label" htmlFor="agent-name">智能体名称</label><input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={48} autoComplete="off" /><div className="hp-create-facts"><span>01 <b>创建工作空间</b></span><span>02 <b>连接自己的模型</b></span><span>03 <b>开始对话与工作</b></span></div><button className="hp-button hp-primary hp-full" disabled={!name.trim()}>创建智能体 <Arrow /></button><small className="hp-demo-note">本次仅演示页面流程，不创建云资源或产生费用。</small></>}</form>}
      {modal === "provider" && <div className="hp-dialog-content"><span className="hp-kicker">模型连接</span><h2>让智能体开始工作</h2><p>连接你自己的模型服务。模型与执行节点以后都可以调整。</p><label className="hp-field-label" htmlFor="model-provider">模型接入</label><select id="model-provider" value={model} onChange={(event) => setModel(event.target.value)}><option>Codex</option><option>Gemini</option><option>兼容 API</option></select><div className="hp-provider-explanation">这里展示接入后的使用流程。本原型不收集密钥，也不发起模型授权。</div><button className="hp-button hp-primary hp-full" onClick={() => { setConnected(true); setModal(null); }}>使用示例连接 <Arrow /></button></div>}
      {modal === "video" && <div className="hp-video"><h2>一个智能体，四线程构建微缩北京。</h2><video controls playsInline preload="metadata" poster="/video/morphz-live-demo-poster-v1.jpg"><source src="/video/morphz-live-demo-en-v1.mp4" type="video/mp4" /><track kind="captions" src="/video/morphz-live-demo-en-v1.vtt" srcLang="en" label="英文字幕" />你的浏览器暂不支持视频播放。</video></div>}
    </dialog>
  </div>;
}
