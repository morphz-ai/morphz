import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Workspace } from "../../../packages/core/src/model.js";
import type { PlatformContent } from "./platform-client.js";
import type { WorkspaceClient } from "./client.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { useModal } from "./useModal.js";
import { Tooltip } from "./ui/Tooltip.js";
import {
  pngBase64,
  renderSharePictures,
  shareImageTemplates,
  type ShareImageTemplate,
  type SharePicture,
} from "./message-share-image.js";
import "./message-share.css";

export type MessageShareContent = {
  text: string;
  author: string;
  createdAt: string;
  format: "plain" | "markdown";
  partial: boolean;
  quotes: readonly { text: string; comment: string }[];
  attachments: readonly string[];
  state: Workspace;
  catalog: readonly PlatformContent[];
};

export function MessageShareDialog({
  content,
  client,
  onClose,
}: {
  content: MessageShareContent;
  client: WorkspaceClient;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [pictures, setPictures] = useState<(SharePicture & { url: string })[]>(
    [],
  );
  const [page, setPage] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [template, setTemplate] = useState<ShareImageTemplate>("card");
  const [renderedTemplate, setRenderedTemplate] =
    useState<ShareImageTemplate | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [generating, setGenerating] = useState(true);
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState({ copy: false, save: false });
  const operation = useRef(0);
  const identity = useRef({
    centerId: client.boot!.centerId,
    principalId: client.boot!.principalId,
  });
  useModal(dialog, close);
  useEffect(() => {
    // Only an explicit preview/page action resets this local scrollport. Runtime
    // updates neither replace the frozen picture nor move the conversation.
    preview.current?.scrollTo({ top: 0, left: 0 });
  }, [page, zoomed]);
  useEffect(() => {
    setCompleted((current) => ({ ...current, copy: false }));
  }, [page]);
  useEffect(() => {
    const controller = new AbortController();
    setGenerating(true);
    setError("");
    setCompleted({ copy: false, save: false });
    void (async () => {
      try {
        const rendered = await renderSharePictures(
          sheet.current!,
          { ...content, template },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setPictures(
            rendered.map((picture) => ({
              ...picture,
              url: URL.createObjectURL(picture.blob),
            })),
          );
          setRenderedTemplate(template);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "图片生成失败，请重试。",
          );
      } finally {
        if (!controller.signal.aborted) setGenerating(false);
      }
    })();
    return () => {
      controller.abort();
      operation.current++;
    };
  }, [attempt, content, template]);
  useEffect(
    () => () => {
      for (const picture of pictures) URL.revokeObjectURL(picture.url);
    },
    [pictures],
  );

  async function output(save: boolean) {
    if (busy || generating || renderedTemplate !== template || !pictures[page])
      return;
    const generation = ++operation.current;
    const action = save ? "save" : "copy";
    setBusy(action);
    setCompleted((current) => ({ ...current, [action]: false }));
    setError("");
    try {
      const native = window.morphzDesktop?.messageImages;
      if (window.morphzDesktop && !native)
        throw new Error("桌面组件尚未加载图片分享功能，请重启 Morphz 后重试。");
      if (native) {
        const values = save ? pictures : [pictures[page]!];
        const request = {
          ...identity.current,
          createdAt: content.createdAt,
          pictures: await Promise.all(
            values.map(async (picture) => ({
              mime: "image/png" as const,
              data: await pngBase64(picture.blob),
            })),
          ),
        };
        if (generation !== operation.current) return;
        const result = await (save
          ? native.save(request)
          : native.copy(request));
        if (generation === operation.current && result.status !== "cancelled")
          setCompleted((current) => ({ ...current, [action]: true }));
      } else if (save) {
        const anchor = document.createElement("a");
        anchor.href = pictures[page]!.url;
        anchor.download = `Morphz-消息-${page + 1}.png`;
        anchor.click();
      } else {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
          throw new Error("当前浏览器无法复制图片，请保存图片后分享。");
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": pictures[page]!.blob }),
        ]);
        if (generation === operation.current)
          setCompleted((current) => ({ ...current, copy: true }));
      }
    } catch (cause) {
      if (generation === operation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "图片操作失败，预览仍保留，可重试。",
        );
    } finally {
      if (generation === operation.current) setBusy(null);
    }
  }
  const picture = pictures[page];
  return createPortal(
    <dialog
      ref={dialog}
      className="create-dialog message-share-dialog"
      aria-label="分享图片"
      data-quote-ignore="true"
      data-expanded={zoomed}
      style={
        picture
          ? ({
              "--message-image-ratio": picture.width / picture.height,
            } as CSSProperties)
          : undefined
      }
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>分享图片</h2>
        <div
          className="message-share-templates"
          role="group"
          aria-label="图片模板"
        >
          {shareImageTemplates.map(({ id, label }) => (
            <button
              key={id}
              aria-pressed={template === id}
              disabled={!!busy}
              onClick={() => {
                if (id === template) return;
                setGenerating(true);
                setTemplate(id);
                setPage(0);
                setZoomed(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          ref={close}
          className="icon-button"
          aria-label="关闭分享图片"
          disabled={!!busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {!picture && generating ? (
        <p role="status" className="message-share-generating muted">
          正在生成图片…
        </p>
      ) : (
        picture && (
          <div
            ref={preview}
            className="message-share-preview"
            role="region"
            aria-label="图片预览"
            aria-busy={generating}
            tabIndex={zoomed ? 0 : undefined}
          >
            <img
              src={picture.url}
              alt={`消息分享图片，第 ${page + 1} 张`}
              width={picture.width}
              height={picture.height}
            />
          </div>
        )
      )}
      <div className="message-share-toolbar">
        <div className="message-share-preview-controls">
          {generating && picture && (
            <span role="status" className="muted">
              正在生成…
            </span>
          )}
          {pictures.length > 1 && (
            <div
              className="message-share-pages"
              role="group"
              aria-label="图片分页"
            >
              <Tooltip label="上一张">
                <button
                  className="icon-button"
                  aria-label="上一张"
                  disabled={page === 0 || !!busy}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft />
                </button>
              </Tooltip>
              <span aria-live="polite">
                {page + 1} / {pictures.length}
              </span>
              <Tooltip label="下一张">
                <button
                  className="icon-button"
                  aria-label="下一张"
                  disabled={page === pictures.length - 1 || !!busy}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight />
                </button>
              </Tooltip>
            </div>
          )}
          <button
            className="message-share-zoom"
            aria-label={zoomed ? "适应窗口" : "放大预览"}
            aria-pressed={zoomed}
            disabled={!picture || generating || !!busy}
            onClick={() => setZoomed(!zoomed)}
          >
            {zoomed ? <ZoomOut /> : <ZoomIn />}
            {zoomed ? "适应" : "放大"}
          </button>
        </div>
        <div className="dialog-actions message-share-actions">
          <button
            className="message-share-copy"
            data-complete={completed.copy || undefined}
            disabled={
              !picture || !!busy || generating || renderedTemplate !== template
            }
            onClick={() => void output(false)}
          >
            {completed.copy ? <Check /> : <Copy />}
            <span className="message-share-action-label" aria-live="polite">
              {busy === "copy"
                ? "复制中…"
                : completed.copy
                  ? "已复制"
                  : "复制图片"}
            </span>
          </button>
          <button
            className="primary"
            disabled={
              !picture || !!busy || generating || renderedTemplate !== template
            }
            onClick={() => void output(true)}
          >
            <span className="message-share-action-label" aria-live="polite">
              {busy === "save"
                ? "保存中…"
                : completed.save
                  ? "已保存"
                  : window.morphzDesktop?.messageImages && pictures.length > 1
                    ? "保存全部"
                    : "保存图片"}
            </span>
          </button>
        </div>
      </div>
      {error && (
        <div className="message-share-error" role="alert">
          <p>{error}</p>
          {(!pictures.length || renderedTemplate !== template) &&
            !generating && (
              <button
                className="secondary-action"
                onClick={() => setAttempt(attempt + 1)}
              >
                重新生成
              </button>
            )}
        </div>
      )}
      <div className="message-share-renderer" aria-hidden="true" inert>
        <div
          className="message-share-sheet"
          ref={sheet}
          data-template={template}
        >
          {content.quotes.map((quote, index) => (
            <blockquote key={index} className="message-share-quote">
              <p>{quote.text}</p>
              {quote.comment && (
                <p className="message-share-comment">{quote.comment}</p>
              )}
            </blockquote>
          ))}
          {content.format === "markdown" ? (
            <SafeMarkdown
              state={content.state}
              catalog={content.catalog}
              onOpen={() => {}}
            >
              {content.text}
            </SafeMarkdown>
          ) : (
            content.text && (
              <p className="message-share-plain">{content.text}</p>
            )
          )}
          {!!content.attachments.length && (
            <p className="message-share-attachments">
              附件：{content.attachments.join("、")}
            </p>
          )}
        </div>
      </div>
    </dialog>,
    document.querySelector(".primary-panel") ?? document.body,
  );
}
