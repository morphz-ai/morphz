import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import { MarkdownTable } from "./MarkdownTable.js";
import { MarkdownTextBlock } from "./MarkdownTextBlock.js";
import { markdownRemarkPlugins } from "./markdown-parsing.js";
import { preserveMarkdownLineBreaks } from "./markdown-line-breaks.js";
import { omitRepeatedDocumentTitle } from "./document-presentation.js";
import {
  contentLink,
  localFileLink,
  relativeFileLink,
  resolveWorkspaceFileLink,
  contentReferenceLinks,
  resourceLinkError,
} from "./resource-links.js";
import { applicationCall } from "./application-transport.js";
import {
  sessionPermissionsSnapshotSchema,
  type SessionPermissionsRead,
} from "../../../packages/core/src/session-permissions.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import type { PlatformContent } from "./platform-client.js";
import {
  advanceStreamText,
  streamingTextPlugin,
  STREAM_TEXT_DURATION,
  type StreamTextState,
} from "./streaming-text.js";
const MarkdownScope = createContext<{
  state: Workspace;
  catalog?: readonly PlatformContent[];
  onOpen: (id: string, revision?: number) => void;
  copyable: boolean;
  resourceScope?: SessionPermissionsRead;
} | null>(null);
const markdownComponents = {
  pre: function MarkdownPre({ children }: { children?: ReactNode }) {
    const scope = useContext(MarkdownScope)!;
    return (
      <MarkdownTextBlock copyable={scope.copyable}>
        {children}
      </MarkdownTextBlock>
    );
  },
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
  table: MarkdownTable,
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
  return contentLink(value)?.id ?? null;
}

function Link({
  href = "",
  children,
  onOpen,
  resourceScope,
}: {
  href?: string;
  children: ReactNode;
  state: Workspace;
  catalog?: readonly PlatformContent[];
  onOpen: (id: string, revision?: number) => void;
  resourceScope?: SessionPermissionsRead;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const target = contentLink(href);
  const path = localFileLink(href);
  const relative = relativeFileLink(href);
  if (target || path || relative)
    return (
      <>
        <button
          type="button"
          className={`inline-object-link${path || relative ? " markdown-file-link" : ""}`}
          aria-busy={busy || undefined}
          disabled={busy}
          title={
            target
              ? `打开内容${target.revision ? ` · v${target.revision}` : ""}`
              : relative
                ? `在原会话的当前执行工作目录中打开：${relative}`
                : `在本机打开：${path}`
          }
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              if (target) await onOpen(target.id, target.revision);
              else {
                if (!window.morphzDesktop)
                  throw new Error("本地文件请在本机桌面应用中打开。");
                if (!window.morphzDesktop.openLocalFile)
                  throw new Error("桌面组件需要重新启动后才能打开本地文件。");
                let localPath = path;
                if (relative) {
                  if (!resourceScope)
                    throw new Error(
                      "此相对文件链接缺少原会话的执行来源，无法安全定位。",
                    );
                  const permissions = sessionPermissionsSnapshotSchema.parse(
                    await applicationCall(
                      "session-permissions.read",
                      resourceScope,
                    ),
                  );
                  if (
                    permissions.scope.projectId !== resourceScope.projectId ||
                    permissions.scope.conversationId !==
                      resourceScope.conversationId ||
                    !permissions.workspace.ready ||
                    permissions.workspace.targetId !== "target-default" ||
                    !permissions.workspace.workspaceRoot
                  )
                    throw new Error(
                      "原会话未连接可确认的本机执行节点，不能把远端或未知目录当作本机打开。",
                    );
                  localPath = resolveWorkspaceFileLink(
                    relative,
                    permissions.workspace.workspaceRoot,
                  );
                  if (!localPath)
                    throw new Error("相对文件地址无效，文件未打开。");
                }
                const result = await window.morphzDesktop.openLocalFile(
                  localPath!,
                );
                if (result.action === "revealed")
                  setError(
                    "此类型可能启动程序，已在文件管理器中定位，请自行确认后打开。",
                  );
              }
            } catch (cause) {
              setError(resourceLinkError(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {children}
        </button>
        {error && (
          <small className="markdown-link-error" role="alert">
            {error}
          </small>
        )}
      </>
    );
  const url = webURL(href);
  if (!url) return <span title="不支持的链接地址">{children}</span>;
  return (
    <>
      <a
        className="markdown-link"
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
            setError(resourceLinkError(cause));
          }
        }}
      >
        {children}
      </a>
      {error && (
        <small className="markdown-link-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}

function Picture({
  src = "",
  alt = "图片",
  state,
  catalog = [],
  onOpen,
}: {
  src?: string;
  alt?: string;
  state: Workspace;
  catalog?: readonly PlatformContent[];
  onOpen: (id: string, revision?: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  const target = contentLink(src);
  const id = target?.id;
  if (target?.revision !== undefined)
    return (
      <Link href={src} state={state} catalog={catalog} onOpen={onOpen}>
        查看图片：{alt}
      </Link>
    );
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
      <Link href={src} state={state} catalog={catalog} onOpen={onOpen}>
        查看外部图片：{alt}
      </Link>
    );
  return id ? (
    <button className="inline-object-link" onClick={() => onOpen(id!)}>
      查看图片：{alt}
    </button>
  ) : (
    <span className="muted">{alt}（图片不可用）</span>
  );
}

/** Content cannot execute code or load remote media just by being rendered. */
export function SafeMarkdown({
  children,
  state,
  catalog,
  onOpen,
  documentTitle,
  streaming = false,
  copyable = true,
  resourceScope,
}: {
  children: string;
  state: Workspace;
  catalog?: readonly PlatformContent[];
  onOpen: (id: string, revision?: number) => void;
  documentTitle?: string;
  streaming?: boolean;
  copyable?: boolean;
  resourceScope?: SessionPermissionsRead;
}) {
  return (
    <MarkdownScope.Provider
      value={{ state, catalog, onOpen, copyable, resourceScope }}
    >
      <MarkdownBody documentTitle={documentTitle} streaming={streaming}>
        {children}
      </MarkdownBody>
    </MarkdownScope.Provider>
  );
}

// Only changed prose needs parsing. Scope stays outside the memo boundary so
// existing links/media still receive fresh permissions, versions and actions.
const MarkdownBody = memo(function MarkdownBody({
  children,
  documentTitle,
  streaming,
}: {
  children: string;
  documentTitle?: string;
  streaming: boolean;
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
    <Markdown
      skipHtml
      remarkPlugins={[
        ...markdownRemarkPlugins,
        contentReferenceLinks,
        [omitRepeatedDocumentTitle, { title: documentTitle }],
      ]}
      rehypePlugins={[
        [streamingTextPlugin, { source: children, ranges: next.ranges }],
        preserveMarkdownLineBreaks,
      ]}
      urlTransform={(url, key) =>
        webURL(url) ||
        objectLink(url) ||
        /^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(url) ||
        (key === "href" && (localFileLink(url) || relativeFileLink(url)))
          ? url
          : ""
      }
      components={markdownComponents}
    >
      {children}
    </Markdown>
  );
});
