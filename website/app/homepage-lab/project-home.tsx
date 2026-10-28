import type { ReactNode } from "react";
import { BrandMark } from "../components/BrandMark";
import { SITE_LINKS } from "@/lib/site";

type ProjectHomeProps = {
  onCreate: () => void;
  onPersona: () => void;
  created: boolean;
  explorer: ReactNode;
  install: ReactNode;
};

const mechanisms = [
  {
    number: "01",
    label: "结构化认知",
    title: "认知上下文自我维护。",
    description: "Morphz 将长期记忆组织为可持久、可版本化、可求值的认知状态。智能体通过显式事务持续修订自己的认知。",
    code: "derive · revise · retire · restore",
    link: "/docs/core-concepts",
    linkText: "理解结构化上下文",
  },
  {
    number: "02",
    label: "并发工作",
    title: "多条工作线同时推进。",
    description: "工具执行、长期任务与新消息可以并发。结果沿原有因果路线返回，不会阻塞其他会话。智能体工作时，你仍能继续对话。",
    code: "会话 · 目标 · 线程 · 激活",
    link: "/docs/execution-lifecycle",
    linkText: "查看并发与调度",
  },
  {
    number: "03",
    label: "可信执行",
    title: "任务运行在目标节点。",
    description: "执行节点把认知求值与物理执行分开。任务可进入本机、托管 SSH 主机或边缘节点，在节点环境的沙箱与最小权限内运行。",
    code: "执行节点 · 能力租约 · 沙箱",
    link: "/docs/execution-targets",
    linkText: "了解执行节点",
  },
] as const;

export function ProjectHome({ onCreate, onPersona, created, explorer, install }: ProjectHomeProps) {
  return <>
    <section className="hp-project-hero hp-width" aria-labelledby="homepage-heading">
      <div className="hp-hero-copy">
        <span className="hp-kicker"><i /> 为长期并发工作而生</span>
        <h1 id="homepage-heading" tabIndex={-1}>一个智能体。<br />多个目标。<br /><em>并发推进。</em></h1>
        <p>Morphz 将结构化认知、并发求值与分布式执行，组织在同一个智能体运行时中。</p>
        <div className="hp-actions">
          <a className="hp-button hp-primary" href="#local-install">本地运行 <span aria-hidden="true">↓</span></a>
          <button className="hp-button" onClick={onCreate}>{created ? "进入我的智能体" : "创建自己的智能体"} <span aria-hidden="true">→</span></button>
        </div>
        <div className="hp-text-links">
          <a href={SITE_LINKS.source} target="_blank" rel="noreferrer">查看源码 <span aria-hidden="true">↗</span></a>
          <a href="/paper" target="_blank" rel="noreferrer">阅读论文 <span aria-hidden="true">↗</span></a>
          <a href="#in-action">实机演示 <span aria-hidden="true">↓</span></a>
        </div>
      </div>
      <div className="hp-project-preview">
        <div className="hp-figure-label"><span>运行机制</span><span>认知 · 并发 · 执行</span></div>
        {explorer}
      </div>
    </section>

    <div className="hp-spec-strip hp-width" aria-label="技术概览">
      <span>Apache-2.0 开源</span><span>结构化上下文</span><span>多路并发求值</span><span>SQLite / PostgreSQL</span><span>本机 · 远程 · 边缘节点</span>
    </div>

    <section className="hp-persona-strip hp-width" aria-labelledby="meet-morphz">
      <div className="hp-persona-symbol" aria-hidden="true"><BrandMark /></div>
      <div><span className="hp-kicker">官方人格 · 共享认知</span><h2 id="meet-morphz">也可以直接和 Morphz 聊聊。</h2><p>不同人的对话，连接着同一个共享认知。请勿在这里发送私人信息。</p></div>
      <button className="hp-button" onClick={onPersona}>与官方 Morphz 对话 <span aria-hidden="true">→</span></button>
    </section>

    <section className="hp-project-demo hp-width" id="in-action" aria-labelledby="in-action-title">
      <div className="hp-project-section-heading">
        <div><span className="hp-kicker">实机演示</span><h2 id="in-action-title">一个智能体，<br />四线程并发构建微缩北京。</h2></div>
        <p>多个目标在同一认知上下文中推进。任务执行期间，你仍然可以继续与智能体对话。</p>
      </div>
      <figure className="hp-recording">
        <div className="hp-recording-bar"><span><i /> Morphz 实机演示</span><a href="/docs/execution-lifecycle" target="_blank" rel="noreferrer">查看运行机制 <span aria-hidden="true">↗</span></a></div>
        <video controls playsInline preload="none" poster="/video/morphz-live-demo-poster-v1.jpg" aria-label="Morphz 实机演示：一个智能体，四线程并发构建微缩北京">
          <source src="/video/morphz-live-demo-en-v1.mp4" type="video/mp4" />
          <track kind="captions" src="/video/morphz-live-demo-en-v1.vtt" srcLang="en" label="英文字幕" />
          你的浏览器暂不支持视频播放。
        </video>
        <figcaption><span>同一个智能体 · 多个目标 · 并发执行</span><a href="/video/morphz-live-demo-en-v1.mp4" target="_blank" rel="noreferrer">单独打开视频 <span aria-hidden="true">↗</span></a></figcaption>
      </figure>
    </section>

    <section className="hp-project-mechanisms hp-width" aria-labelledby="mechanisms-title">
      <div className="hp-project-section-heading"><div><span className="hp-kicker">核心机制</span><h2 id="mechanisms-title">维护认知，并发工作，连接真实环境。</h2></div><a className="hp-inline-link" href="/docs" target="_blank" rel="noreferrer">阅读技术文档 <span aria-hidden="true">↗</span></a></div>
      <div className="hp-project-mechanism-grid">{mechanisms.map((item) => <article key={item.number}>
        <div className="hp-project-mechanism-label"><span>{item.number}</span><small>{item.label}</small></div>
        <h3>{item.title}</h3><p>{item.description}</p><code>{item.code}</code><a href={item.link} target="_blank" rel="noreferrer">{item.linkText} <span aria-hidden="true">↗</span></a>
      </article>)}</div>
      <div className="hp-project-extension"><span className="hp-kicker">认知应用</span><p>认知应用组织领域能力；领域程序包定义工作方式；Yao 为模型与运行时提供共享的认知求值语言。</p><a href="/standards" target="_blank" rel="noreferrer">开放规范 <span aria-hidden="true">↗</span></a></div>
    </section>

    <section className="hp-project-research hp-width" aria-labelledby="research-title">
      <div className="hp-project-research-copy"><span className="hp-kicker">研究论文</span><h2 id="research-title">结构化上下文上的<br />非确定性认知符号求值。</h2><p>论文介绍 Morphz 的计算模型、实现与分层实验。评测协议、对照结果和实验资料随论文公开。</p><div className="hp-text-links"><a href="/paper" target="_blank" rel="noreferrer">阅读论文与评测 <span aria-hidden="true">↗</span></a><a href={SITE_LINKS.research} target="_blank" rel="noreferrer">实验资料 <span aria-hidden="true">↗</span></a></div></div>
      <a className="hp-project-result" href="/paper" target="_blank" rel="noreferrer" aria-label="查看论文中的 STATE-Bench 衍生评测协议和结果">
        <span>基于 STATE-Bench 的更新评测协议</span><div><strong>122</strong><span>/ 150</span></div><h3>Morphz 评测结果</h3><p>Letta 93 / 150 · Mem0 96 / 150</p><footer>查看评测设置与完整结果 <span aria-hidden="true">↗</span></footer>
      </a>
    </section>

    <section className="hp-project-start hp-width" aria-labelledby="start-title">
      <div className="hp-project-section-heading"><div><span className="hp-kicker">第一次运行</span><h2 id="start-title">在自己的机器上，启动 Morphz。</h2></div><p>一条命令安装预编译版本；随后通过设置向导连接模型服务并启动 Morphz。</p></div>
      {install}
      <div className="hp-project-start-links"><a href="/docs/getting-started" target="_blank" rel="noreferrer">快速开始 <span aria-hidden="true">↗</span></a><a href="/download" target="_blank" rel="noreferrer">所有安装方式 <span aria-hidden="true">↗</span></a><a href={SITE_LINKS.releases} target="_blank" rel="noreferrer">版本发布 <span aria-hidden="true">↗</span></a></div>
      <div className="hp-project-web-entry"><div><h3>也可以从浏览器开始。</h3><p>登录后创建自己的智能体，连接模型，进入独立工作空间。</p></div><button className="hp-button" onClick={onCreate}>{created ? "进入我的智能体" : "创建自己的智能体"} <span aria-hidden="true">→</span></button></div>
    </section>
  </>;
}

export function ProjectFooter({ onCreate, onPersona, created }: Pick<ProjectHomeProps, "onCreate" | "onPersona" | "created">) {
  return <footer className="hp-project-footer hp-width">
    <div className="hp-project-footer-brand"><div className="brand"><BrandMark /><span className="brand__name">Morphz</span></div><p>让一个智能体在同一认知上下文中，<br />维护认知，并发推进多个目标。</p><small>由新变元创造并维护。</small></div>
    <div><h2>开始使用</h2><a href="#local-install">本地运行</a><button onClick={onCreate}>{created ? "我的智能体" : "创建自己的智能体"}</button><button onClick={onPersona}>与官方 Morphz 对话</button></div>
    <div><h2>了解技术</h2><a href="/docs" target="_blank" rel="noreferrer">文档</a><a href="/paper" target="_blank" rel="noreferrer">论文与评测</a><a href="/standards" target="_blank" rel="noreferrer">开放规范</a><a href="/blog" target="_blank" rel="noreferrer">技术文章</a></div>
    <div><h2>参与项目</h2><a href={SITE_LINKS.source} target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a><a href={SITE_LINKS.issues} target="_blank" rel="noreferrer">反馈问题 <span aria-hidden="true">↗</span></a><a href={SITE_LINKS.releases} target="_blank" rel="noreferrer">版本发布 <span aria-hidden="true">↗</span></a></div>
    <div className="hp-project-footer-bottom"><span>Morphz</span><span>Apache-2.0 开源协议</span></div>
  </footer>;
}
