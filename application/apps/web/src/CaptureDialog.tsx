import { useModal } from "./useModal.js";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Scan, X } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import { syncNativeBrowserLayout } from "./native-browser-layout.js";
import { useImagePreviewSize } from "./useImagePreviewSize.js";
export function CaptureDialog({
  client,
  projectId,
  hideWindow = false,
  artifactId,
  artifactRevision,
  onClose,
  onSaved,
  onAttach,
}: {
  onAttach?: (attachment: InputAttachment) => void;
  client: WorkspaceClient;
  projectId: string;
  hideWindow?: boolean;
  artifactId?: string;
  artifactRevision?: number;
  onClose(): void;
  onSaved(id: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    selectButton = useRef<HTMLButtonElement>(null),
    epoch = useRef(0),
    [picture, setPicture] = useState<{
      mime: "image/png";
      data: string;
    } | null>(null),
    [busy, setBusy] = useState(!!window.morphzDesktop?.capture),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [title, setTitle] = useState("现场截图");
  const created = useRef<string | null>(null);
  const uploaded = useRef<string | null>(null);
  const [preview, setPreview] = useState("");
  const imageSize = useImagePreviewSize();
  useEffect(() => {
    if (!picture) return;
    const bytes = Uint8Array.from(atob(picture.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: picture.mime }));
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picture]);
  useModal(dialog);
  useEffect(() => {
    // A live UI update must not discard a selected image or start another capture.
    if (picture) return;
    // The explicit screenshot action mounts this component. Let the hidden
    // confirmation layer paint before entering the native picker, once only.
    const generation = epoch.current;
    const frame = requestAnimationFrame(() => {
      if (generation === epoch.current && window.morphzDesktop?.capture)
        void select(true, hideWindow);
    });
    return () => {
      cancelAnimationFrame(frame);
      epoch.current++;
      void window.morphzDesktop?.capture.cancel().catch(() => {});
    };
  }, []);
  async function restore(request: number) {
    if (request !== epoch.current) return;
    flushSync(() => setBusy(false));
    // Revoke page control under the restored modal before returning focus.
    await syncNativeBrowserLayout().catch(() => {});
    if (request === epoch.current)
      selectButton.current?.focus({ preventScroll: true });
  }
  async function cancelSelection() {
    // Cancellation may precede capture.select while waiting for native layout.
    const request = ++epoch.current;
    await window.morphzDesktop?.capture.cancel().catch(() => {});
    await restore(request);
    if (request === epoch.current && !picture) onClose();
  }
  async function select(initial = false, hideWindow = false) {
    if ((busy && !initial) || saving) return;
    const request = ++epoch.current;
    let cancelledInitial = false;
    setError("");
    // Keep the modal mounted (and the background inert), but remove all
    // capture/composer chrome from the picture before opening the OS picker.
    flushSync(() => setBusy(true));
    try {
      await syncNativeBrowserLayout();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (request !== epoch.current) return;
      const next = await window.morphzDesktop?.capture.select({ hideWindow });
      cancelledInitial = !next && !picture;
      if (request === epoch.current && next) {
        setPicture(next);
        created.current = null;
        uploaded.current = null;
      }
    } catch (e) {
      if (request === epoch.current)
        setError(e instanceof Error ? e.message : "截图失败。");
    } finally {
      await restore(request);
      // Restore the invoking controls before the modal returns their focus.
      if (request === epoch.current && cancelledInitial) onClose();
    }
  }
  async function save(asAttachment = false) {
    if (!picture || saving) return;
    setSaving(true);
    setError("");
    try {
      if (!uploaded.current) {
        const bytes = Uint8Array.from(atob(picture.data), (c) =>
          c.charCodeAt(0),
        );
        const { assetId } = await client.upload(
          new File([bytes], "selection.png", { type: picture.mime }),
        );
        uploaded.current = assetId;
      }
      if (asAttachment && onAttach) {
        onAttach({
          assetId: uploaded.current,
          mime: "image/png",
          name: title.trim() ? title.trim() + ".png" : "截图.png",
        });
        return;
      }
      if (!created.current) {
        const receipt = await client.execute({
          type: "create-artifact",
          projectId,
          title: title.trim(),
          content: {
            kind: "image",
            assetId: uploaded.current,
            alt: artifactId
              ? `围绕对象 ${artifactId} v${artifactRevision} 手动选择的截图`
              : "手动选择的现场截图",
          },
        });
        created.current = receipt.entityId;
      }
      if (artifactId)
        await client.execute({
          type: "link-artifacts",
          fromId: created.current,
          toId: artifactId,
          relation: "references",
        });
      onSaved(created.current);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "保存失败，预览仍保留，可重试。",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={`create-dialog capture-dialog${picture ? " image-preview-dialog" : ""}`}
      style={imageSize.style}
      data-capturing={busy ? "true" : undefined}
      aria-label="截图输入"
      onCancel={(e) => {
        e.preventDefault();
        if (busy) void cancelSelection();
        else if (!saving) onClose();
      }}
    >
      <header>
        <div>
          <h2>截图</h2>
          {artifactId && <small>当前对象 · v{artifactRevision}</small>}
        </div>
        <div className="dialog-actions">
          <button
            ref={selectButton}
            className="capture-start secondary-action"
            disabled={!window.morphzDesktop?.capture || busy || saving}
            title={`按住 ${/Mac/.test(navigator.platform) ? "Option" : "Alt"} 点击隐藏 Morphz`}
            onClick={(event) => void select(false, event.altKey)}
          >
            <Scan />
            {busy ? "截图中…" : picture ? "重新划区" : "开始划区"}
          </button>
          <button
            className="icon-button"
            aria-label="关闭截图输入"
            disabled={saving}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
      </header>
      {!window.morphzDesktop?.capture && (
        <p>请在桌面应用中截图，或使用导入图片。</p>
      )}
      {picture && (
        <div className="image-preview-frame">
          <img
            className="capture-preview"
            alt="待确认的截图"
            src={preview || undefined}
            onLoad={imageSize.onLoad}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <footer>
        {picture && (
          <label className="capture-title">
            <span>名称</span>
            <input
              aria-label="截图标题"
              maxLength={180}
              value={title}
              disabled={saving || !!created.current}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        )}
        <div className="capture-confirm-actions">
          <button
            className="secondary-action"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className={onAttach ? "secondary-action" : "primary"}
            disabled={!picture || busy || saving || !title.trim()}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存到内容"}
          </button>
          {onAttach && (
            <button
              className="primary"
              disabled={!picture || busy || saving}
              onClick={() => void save(true)}
            >
              添加到消息
            </button>
          )}
        </div>
      </footer>
    </dialog>
  );
}
