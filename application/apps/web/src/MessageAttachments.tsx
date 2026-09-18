import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { Paperclip, X } from "lucide-react";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { restoreInputToolFocus } from "./input-tool-focus.js";
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
  inputRef,
}: {
  previewTarget: HTMLElement | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  client: WorkspaceClient;
  attachments: InputAttachment[];
  disabled: boolean;
  allowAdd?: boolean;
  onChange(value: (previous: InputAttachment[]) => InputAttachment[]): void;
  onError(message: string): void;
  onBusy(busy: boolean): void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const adding = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  function finishSelection(restoreFocus = false) {
    setSelecting(false);
    onBusy(false);
    if (restoreFocus) restoreInputToolFocus(trigger.current);
  }
  useEffect(() => {
    const element = file.current;
    const cancel = () => finishSelection(true);
    element?.addEventListener("cancel", cancel);
    return () => element?.removeEventListener("cancel", cancel);
  }, [allowAdd, onBusy]);
  async function addFiles(files: File[], fromPicker = false) {
    const origin = fromPicker ? trigger.current : null;
    if (!files.length) {
      finishSelection(fromPicker);
      return;
    }
    if (adding.current || (disabled && !selecting)) {
      onError("正在处理输入，请稍后再添加附件。");
      return;
    }
    if (attachments.length + files.length > 8) {
      finishSelection(fromPicker);
      onError("一条消息最多附加 8 个文件。");
      return;
    }
    adding.current = true;
    setBusy(true);
    onBusy(true);
    onError("");
    const added: InputAttachment[] = [];
    const errors: string[] = [];
    try {
      for (const value of files) {
        try {
          const { assetId, mime } = await client.uploadAttachment(value);
          added.push({ assetId, mime, name: value.name.slice(0, 180) });
        } catch (error) {
          errors.push(
            `${value.name}：${error instanceof Error ? error.message : "添加失败，请重试。"}`,
          );
        }
      }
    } finally {
      // These callbacks belong to the originating draft, even if the user has
      // navigated elsewhere while a file was uploading.
      onChange((previous) => [...previous, ...added]);
      if (errors.length) onError(errors.join("\n"));
      adding.current = false;
      setBusy(false);
      onBusy(false);
      if (fromPicker) restoreInputToolFocus(origin);
    }
  }
  useEffect(() => {
    const input = inputRef.current;
    function paste(event: ClipboardEvent) {
      const data = event.clipboardData;
      if (!data) return;
      // Read only the files supplied by this paste gesture, before the event's
      // data store expires. Never poll the clipboard or resolve pasted paths.
      const files = Array.from(data.files);
      if (!files.length) return; // Keep native text insertion and undo intact.
      event.preventDefault();
      if (!allowAdd) {
        onError("当前输入不支持附件。");
        return;
      }
      void addFiles(files);
    }
    input?.addEventListener("paste", paste);
    return () => input?.removeEventListener("paste", paste);
  });
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
                  onClick={() => {
                    // This focused button is about to unmount. Keep the
                    // user's next keystroke in the same, unsent draft.
                    inputRef.current?.focus({ preventScroll: true });
                    onChange((previous) =>
                      previous.filter((_, i) => i !== index),
                    );
                  }}
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
          ref={trigger}
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
              finishSelection(true);
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
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            const fromPicker = selecting;
            setSelecting(false);
            void addFiles(files, fromPicker);
          }}
        />
      )}
    </>
  );
}
