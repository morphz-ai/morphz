import { createContext, useContext, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { omitRepeatedDocumentTitle } from "./document-presentation.js";
import type { Workspace } from "../../../packages/core/src/model.js";
const MarkdownScope = createContext<{
  state: Workspace;
  onOpen: (id: string) => void;
} | null>(null);
const markdownComponents = {
  a: function MarkdownLink({
    href,
    children,
  }: {
    href?: string;
    children?: ReactNode;
  }) {
    const scope = useContext(MarkdownScope)!;
    return (
      <Link key={href} href={href} {...scope}>
        {children}
      </Link>
    );
  },
  img: function MarkdownImage({
    src,
    alt,
  }: {
    src?: string | Blob;
    alt?: string;
  }) {
    const scope = useContext(MarkdownScope)!;
    const url = typeof src === "string" ? src : "";
    return <Picture key={url} src={url} alt={alt} {...scope} />;
  },
};

export function webURL(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function objectLink(value: string): string | null {
  return (
    /^(?:morphz:\/\/artifact\/|artifact:|\/artifacts\/)([a-zA-Z0-9_-]+)$/.exec(
      value,
    )?.[1] ?? null
  );
}

function Link({
  href = "",
  children,
  state,
  onOpen,
}: {
  href?: string;
  children: ReactNode;
  state: Workspace;
  onOpen: (id: string) => void;
}) {
  const [error, setError] = useState("");
  const id = objectLink(href);
  if (id)
    return state.artifacts.some((a) => a.id === id) ? (
      <button className="inline-object-link" onClick={() => onOpen(id)}>
        {children}
      </button>
    ) : (
      <span title="对象不存在或无访问权限">{children}（不可用）</span>
    );
  const url = webURL(href);
  if (!url) return <span title="不支持的链接地址">{children}</span>;
  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="在系统浏览器打开"
        onClick={async (e) => {
          if (!window.morphzDesktop) return;
          e.preventDefault();
          try {
            if (!window.morphzDesktop.openExternal)
              throw new Error("桌面组件需要重新启动后才能打开链接。");
            await window.morphzDesktop.openExternal(url);
            setError("");
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "链接未打开，请重试。",
            );
          }
        }}
      >
        {children}
      </a>
      {error && <small role="alert">{error}</small>}
    </>
  );
}

function Picture({
  src = "",
  alt = "图片",
  state,
  onOpen,
}: {
  src?: string;
  alt?: string;
  state: Workspace;
  onOpen: (id: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const id = objectLink(src);
  const artifact = state.artifacts.find((a) => a.id === id);
  const asset =
    /^\/api\/assets\/([a-zA-Z0-9_-]+)$/.exec(src)?.[1] ??
    (artifact?.content.kind === "image" ? artifact.content.assetId : null);
  const accessible =
    asset &&
    state.artifacts.some(
      (a) => a.content.kind === "image" && a.content.assetId === asset,
    );
  if (accessible && !failed)
    return (
      <img
        src={"/api/assets/" + asset}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  if (webURL(src))
    return (
      <Link href={src} state={state} onOpen={onOpen}>
        查看外部图片：{alt}
      </Link>
    );
  return <span className="muted">{alt}（图片不可用）</span>;
}

/** Content cannot execute code or load remote media just by being rendered. */
export function SafeMarkdown({
  children,
  state,
  onOpen,
  documentTitle,
}: {
  children: string;
  state: Workspace;
  onOpen: (id: string) => void;
  documentTitle?: string;
}) {
  return (
    <MarkdownScope.Provider value={{ state, onOpen }}>
      <Markdown
        skipHtml
        remarkPlugins={[[omitRepeatedDocumentTitle, { title: documentTitle }]]}
        urlTransform={(url) =>
          webURL(url) ||
          objectLink(url) ||
          /^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(url)
            ? url
            : ""
        }
        components={markdownComponents}
      >
        {children}
      </Markdown>
    </MarkdownScope.Provider>
  );
}
