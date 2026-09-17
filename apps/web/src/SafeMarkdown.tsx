import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import { omitRepeatedDocumentTitle } from "./document-presentation.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import {
  advanceStreamText,
  streamingTextPlugin,
  STREAM_TEXT_DURATION,
  type StreamTextState,
} from "./streaming-text.js";
const MarkdownScope = createContext<{
  state: Workspace;
  onOpen: (id: string) => void;
} | null>(null);
const markdownComponents = {
  span: function StreamText({
    children,
    node,
  }: {
    children?: ReactNode;
    node?: { properties?: Record<string, unknown> };
  }) {
    const element = useRef<HTMLSpanElement>(null);
    const at = Number(node?.properties?.["data-stream-at"]);
    const offset = Number(node?.properties?.["data-stream-offset"]);
    useLayoutEffect(() => {
      const elapsed = Date.now() - at;
      const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
      const reduced = () =>
        motion.matches ||
        document.documentElement.dataset.appMotion === "reduce";
      if (
        !element.current ||
        !Number.isFinite(at) ||
        elapsed >= STREAM_TEXT_DURATION ||
        reduced()
      )
        return;
      const animation = element.current.animate(
        [
          { opacity: 0.12, filter: "blur(2.4px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        { duration: STREAM_TEXT_DURATION, easing: "ease-out", fill: "both" },
      );
      // Reconstructed Markdown nodes resume their original reveal; never flash
      // old text on a formatting change or a concurrent token update.
      animation.currentTime = Math.max(0, elapsed);
      const reduce = () => {
        if (reduced()) animation.cancel();
      };
      motion.addEventListener("change", reduce);
      window.addEventListener("morphz:motion-preference-changed", reduce);
      return () => {
        motion.removeEventListener("change", reduce);
        window.removeEventListener("morphz:motion-preference-changed", reduce);
        animation.cancel();
      };
    }, [at, offset]);
    return (
      <span
        ref={element}
        className={Number.isFinite(at) ? "stream-text-reveal" : undefined}
        data-stream-at={Number.isFinite(at) ? at : undefined}
      >
        {children}
      </span>
    );
  },
  table: function MarkdownTable({ children }: { children?: ReactNode }) {
    return (
      <div
        className="markdown-table-scroll"
        role="region"
        aria-label="表格"
        tabIndex={0}
      >
        <table>{children}</table>
      </div>
    );
  },
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
  streaming = false,
}: {
  children: string;
  state: Workspace;
  onOpen: (id: string) => void;
  documentTitle?: string;
  streaming?: boolean;
}) {
  const previous = useRef<StreamTextState>({
    source: children,
    active: streaming,
    ranges: [],
  });
  const next = advanceStreamText(
    previous.current,
    children,
    streaming,
    Date.now(),
  );
  useLayoutEffect(() => {
    previous.current = next;
  });
  return (
    <MarkdownScope.Provider value={{ state, onOpen }}>
      <Markdown
        skipHtml
        remarkPlugins={[
          remarkGfm,
          remarkCjkFriendly,
          [omitRepeatedDocumentTitle, { title: documentTitle }],
        ]}
        rehypePlugins={[
          [streamingTextPlugin, { source: children, ranges: next.ranges }],
        ]}
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
