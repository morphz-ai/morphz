import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import { useModal } from "./useModal.js";
const PdfAttachment = lazy(() =>
  import("./PdfReader.js").then((m) => ({ default: m.PdfAttachment })),
);

/** Preview the same scoped resource in place; never navigate the app or create an Artifact. */
export function AttachmentPreview({
  attachment: a,
}: {
  attachment: InputAttachment;
}) {
  const [open, setOpen] = useState(false);
  const image = !a.mime || a.mime.startsWith("image/");
  return (
    <>
      <button
        className="attachment-preview-button"
        title={a.name}
        aria-label={`预览附件 ${a.name}`}
        onClick={() => setOpen(true)}
      >
        {image ? (
          <img src={`/api/attachments/${a.assetId}`} alt={a.name} />
        ) : (
          <span className="attachment-file">
            <FileText />
            {a.name}
          </span>
        )}
      </button>
      {open && <Preview a={a} onClose={() => setOpen(false)} />}
    </>
  );
}
function Preview({ a, onClose }: { a: InputAttachment; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState("");
  useModal(dialog);
  const url = `/api/attachments/${a.assetId}`;
  useEffect(() => {
    if (!a.mime?.startsWith("text/")) return;
    const abort = new AbortController();
    void fetch(url, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("附件不可读取，请检查连接与访问权限。");
        setText(await r.text());
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [url, a.mime]);
  return (
    <dialog
      ref={dialog}
      className="create-dialog attachment-preview-dialog"
      aria-label={`附件预览：${a.name}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <strong>{a.name}</strong>
        <button aria-label="关闭附件预览" onClick={onClose}>
          <X />
        </button>
      </header>
      {error ? (
        <p role="alert">{error}</p>
      ) : a.mime === "application/pdf" ? (
        <Suspense fallback={<p>正在打开 PDF…</p>}>
          <PdfAttachment url={url} />
        </Suspense>
      ) : a.mime?.startsWith("text/") ? (
        <pre>{text ?? "正在读取…"}</pre>
      ) : (
        <img
          src={url}
          alt={a.name}
          onError={() => setError("图片不可读取，请检查连接与访问权限。")}
        />
      )}
    </dialog>
  );
}
