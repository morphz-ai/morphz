import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Paperclip, X } from "lucide-react";
import { AttachmentPreview } from "./AttachmentPreview.js";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";

/** Resources belong to the draft, not the content catalogue. */
export function MessageAttachments({
  client,
  attachments,
  disabled,
  allowAdd = true,
  onChange,
  onError,
  onBusy,
  previewTarget,
}: {
  previewTarget: HTMLElement | null;
  client: WorkspaceClient;
  attachments: InputAttachment[];
  disabled: boolean;
  allowAdd?: boolean;
  onChange(value: (previous: InputAttachment[]) => InputAttachment[]): void;
  onError(message: string): void;
  onBusy(busy: boolean): void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  function finishSelection() {
    setSelecting(false);
    onBusy(false);
  }
  useEffect(() => {
    const element = file.current;
    element?.addEventListener("cancel", finishSelection);
    return () => element?.removeEventListener("cancel", finishSelection);
  }, [allowAdd, onBusy]);
  return (
    <>
      {previewTarget &&
        attachments.length > 0 &&
        createPortal(
          <div className="message-attachments" aria-label="消息附件">
            {attachments.map((a, index) => (
              <div className="message-attachment" key={a.assetId + index}>
                <AttachmentPreview attachment={a} />
                <button
                  className="remove-attachment"
                  disabled={disabled || busy}
                  aria-label={`移除附件 ${a.name}`}
                  onClick={() =>
                    onChange((previous) =>
                      previous.filter((_, i) => i !== index),
                    )
                  }
                >
                  <X />
                </button>
              </div>
            ))}
          </div>,
          previewTarget,
        )}
      {allowAdd && (
        <button
          className="icon-button"
          aria-label="附加文件"
          disabled={disabled || busy || selecting || attachments.length >= 8}
          title={
            selecting
              ? "正在选择文件…"
              : busy
                ? "正在添加…"
                : "附加文件到这条消息，不保存为内容"
          }
          onClick={() => {
            // Native file pickers blur the window. Keep the originating draft
            // mounted before opening it, otherwise auto-collapse detaches the
            // file input and the OS chooser cannot deliver its selection.
            flushSync(() => {
              setSelecting(true);
              onBusy(true);
            });
            try {
              file.current?.click();
            } catch (error) {
              finishSelection();
              onError(
                error instanceof Error ? error.message : "无法打开文件选择器。",
              );
            }
          }}
        >
          <Paperclip />
        </button>
      )}
      {allowAdd && (
        <input
          className="hidden-file"
          aria-label="消息附件文件"
          type="file"
          ref={file}
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.markdown"
          multiple
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            setSelecting(false);
            if (attachments.length + files.length > 8) {
              onBusy(false);
              onError("一条消息最多附加 8 个文件。");
              return;
            }
            setBusy(true);
            onBusy(true);
            const added: InputAttachment[] = [];
            try {
              for (const value of files) {
                const { assetId, mime } = await client.uploadAttachment(value);
                added.push({ assetId, mime, name: value.name.slice(0, 180) });
              }
            } catch (e) {
              onError(
                e instanceof Error
                  ? e.message
                  : "添加失败，已添加的附件仍保留。",
              );
            } finally {
              onChange((previous) => [...previous, ...added]);
              setBusy(false);
              onBusy(false);
            }
          }}
        />
      )}
    </>
  );
}
