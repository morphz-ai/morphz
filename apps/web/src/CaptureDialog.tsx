import { useModal } from "./useModal.js";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Scan, X } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import { syncNativeBrowserLayout } from "./native-browser-layout.js";
export function CaptureDialog({
  client,
  projectId,
  artifactId,
  artifactRevision,
  onClose,
  onSaved,
  onAttach,
}: {
  onAttach?: (attachment: InputAttachment) => void;
  client: WorkspaceClient;
  projectId: string;
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
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [title, setTitle] = useState("现场截图");
  const created = useRef<string | null>(null);
  const uploaded = useRef<string | null>(null);
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!picture) return;
    const bytes = Uint8Array.from(atob(picture.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: picture.mime }));
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picture]);
  useModal(dialog);
  useEffect(() => {
    return () => {
      epoch.current++;
      void window.morphzDesktop?.capture.cancel().catch(() => {});
    };
  }, []);
  async function restore(request: number) {
    if (request !== epoch.current) return;
    flushSync(() => setBusy(false));
    // Hide any native webpage again before presenting the confirmation.
    await syncNativeBrowserLayout().catch(() => {});
    if (request === epoch.current)
      selectButton.current?.focus({ preventScroll: true });
  }
  async function cancelSelection() {
    // Cancellation may precede capture.select while waiting for native layout.
    const request = ++epoch.current;
    await window.morphzDesktop?.capture.cancel().catch(() => {});
    await restore(request);
  }
  async function select() {
    if (busy || saving) return;
    const request = ++epoch.current;
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
      const next = await window.morphzDesktop?.capture.select();
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
      className="create-dialog capture-dialog"
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
          <h2>截图输入</h2>
          <small>
            {onAttach
              ? "添加到这条消息 · 不自动发送"
              : artifactId
                ? `关联当前对象 · v${artifactRevision}`
                : "保存到当前项目"}
          </small>
        </div>
        <button aria-label="关闭截图输入" disabled={saving} onClick={onClose}>
          <X />
        </button>
      </header>
      <p className="muted">
        手动选择一个窗口或区域。按空格切换窗口选择，Esc
        取消。确认前只在本机预览，不发送给 Agent。
      </p>
      <button
        ref={selectButton}
        className="capture-start"
        disabled={!window.morphzDesktop?.capture || busy || saving}
        onClick={() => void select()}
      >
        <Scan />
        {busy
          ? "请在系统界面选择范围…"
          : picture
            ? "重新选择范围"
            : "选择窗口或区域"}
      </button>
      {!window.morphzDesktop?.capture && (
        <p>请在桌面应用中截图，或使用导入图片。</p>
      )}
      {picture && (
        <>
          <img
            className="capture-preview"
            alt="待确认的截图"
            src={preview || undefined}
          />
          <label className="field">
            标题
            <input
              aria-label="截图标题"
              maxLength={180}
              value={title}
              disabled={saving || !!created.current}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <footer>
        <button disabled={saving} onClick={onClose}>
          取消
        </button>
        <button
          className={onAttach ? "" : "primary"}
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
      </footer>
    </dialog>
  );
}
