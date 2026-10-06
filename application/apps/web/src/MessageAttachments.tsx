import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  FilePlus,
  FilePenLine,
  Film,
  ListChecks,
  Layers,
  Paperclip,
  Plus,
  SquareBottomDashedScissors,
  X,
} from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";
import { ComposerCreationMenu } from "./ComposerCreationMenu.js";
import {
  builtinCreationIntents,
  type CognitiveCreationChoice,
} from "./composer-creation-model.js";
import type { InputIntent } from "../../../packages/core/src/input-intent.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { restoreInputToolFocus } from "./input-tool-focus.js";
import type { InputAttachment } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import { messageAttachmentSizeIssue } from "../../../packages/core/src/message-attachment-policy.js";

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
  variant = "tool",
  capture,
  creation,
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
  variant?: "tool" | "menu";
  capture?: {
    disabled?: boolean;
    title?: string;
    onSelect(hideWindow: boolean): void;
  };
  creation?: {
    disabled?: boolean;
    builtinDisabled?: boolean;
    cognitiveDisabled?(choice: CognitiveCreationChoice): boolean;
    disabledReason?: string;
    choices: readonly CognitiveCreationChoice[];
    onBuiltin(intent: InputIntent): void;
    onCognitive(choice: CognitiveCreationChoice): void;
  };
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
          const sizeIssue = messageAttachmentSizeIssue(value);
          if (sizeIssue) throw new Error(sizeIssue);
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
  useEffect(() => {
    const input = inputRef.current;
    const composer = input?.closest<HTMLElement>(".composer") ?? input;
    if (!composer) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) =>
      !!event.dataTransfer &&
      (Array.from(event.dataTransfer.types).includes("Files") ||
        Array.from(event.dataTransfer.items).some(
          (item) => item.kind === "file",
        ));
    const clear = () => {
      depth = 0;
      delete composer.dataset.fileDrop;
    };
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      if (allowAdd && !disabled && !adding.current)
        composer.dataset.fileDrop = "ready";
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect =
        allowAdd && !disabled && !adding.current ? "copy" : "none";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) clear();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return; // Text dragging retains native insertion.
      event.preventDefault();
      clear();
      if (!allowAdd) {
        onError("当前输入不支持附件。");
        return;
      }
      const data = event.dataTransfer!;
      if (
        Array.from(data.items).some(
          (item) => item.webkitGetAsEntry?.()?.isDirectory,
        )
      ) {
        onError("请拖入文件，不支持文件夹。");
        return;
      }
      const files = Array.from(data.files); // Capture only this explicit gesture.
      if (!files.length) return;
      input?.focus({ preventScroll: true });
      void addFiles(files);
    };
    composer.addEventListener("dragenter", enter);
    composer.addEventListener("dragover", over);
    composer.addEventListener("dragleave", leave);
    composer.addEventListener("drop", drop);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      composer.removeEventListener("dragenter", enter);
      composer.removeEventListener("dragover", over);
      composer.removeEventListener("dragleave", leave);
      composer.removeEventListener("drop", drop);
      window.removeEventListener("blur", clear);
    };
  });
  function chooseFiles() {
    // Native file pickers blur the window. Suspend collapse before opening.
    flushSync(() => {
      setSelecting(true);
      onBusy(true);
    });
    try {
      file.current?.click();
    } catch (error) {
      finishSelection(true);
      onError(error instanceof Error ? error.message : "无法打开文件选择器。");
    }
  }
  const fileDisabled = disabled || busy || selecting || attachments.length >= 8;
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
      {allowAdd && variant === "menu" && (
        <ComposerOptions
          align="start"
          label={creation ? "新建或添加" : "添加输入内容"}
          menuLabel={creation ? "新建与添加" : "添加到这条消息"}
          triggerIcon={<Plus />}
          triggerClassName="icon-button composer-add"
          triggerRef={trigger}
          menuClassName="composer-add-menu"
          options={[]}
          content={(close) => (
            <ComposerCreationMenu
              onClose={close}
              primary={
                creation
                  ? builtinCreationIntents.map((intent) => ({
                      key: intent.intent,
                      label: intent.label,
                      application: intent.application,
                      icon:
                        intent.intent === "script" ? (
                          <Film />
                        ) : intent.intent === "task" ? (
                          <ListChecks />
                        ) : (
                          <FilePenLine />
                        ),
                      disabled:
                        disabled ||
                        creation.disabled ||
                        creation.builtinDisabled,
                      title:
                        creation.disabled || creation.builtinDisabled
                          ? creation.disabledReason
                          : undefined,
                      onSelect: () => creation.onBuiltin(intent.intent),
                    }))
                  : []
              }
              additional={(creation?.choices ?? []).map((choice) => ({
                key: choice.key,
                label: choice.intent.label,
                application: `${choice.application} · ${choice.connectionLabel}`,
                icon: <Layers />,
                disabled:
                  disabled ||
                  creation?.disabled ||
                  creation?.cognitiveDisabled?.(choice),
                title:
                  creation?.disabled || creation?.cognitiveDisabled?.(choice)
                    ? creation.disabledReason
                    : `${choice.intent.label} · ${choice.application} · 数据连接：${choice.connectionLabel} · ${choice.target.connectionId}`,
                onSelect: () => creation?.onCognitive(choice),
              }))}
              attachments={
                <>
                  {capture && (
                    <button
                      type="button"
                      className="composer-capture-action composer-creation-attachment"
                      aria-label="截图输入"
                      title={capture.title}
                      disabled={capture.disabled}
                      onClick={(event) => {
                        // Move focus to the persistent + before the capture panel opens.
                        trigger.current?.focus({ preventScroll: true });
                        close();
                        capture.onSelect(event.altKey);
                      }}
                    >
                      <SquareBottomDashedScissors />
                      <span>截图</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="composer-creation-attachment"
                    aria-label="附加文件"
                    title="支持的文件以实际附件能力为准；不保存为内容库对象"
                    disabled={fileDisabled}
                    onClick={() => {
                      close();
                      chooseFiles();
                    }}
                  >
                    <FilePlus />
                    <span>
                      {selecting
                        ? "正在选择文件…"
                        : busy
                          ? "正在添加…"
                          : "图片或文件"}
                    </span>
                  </button>
                </>
              }
            />
          )}
        />
      )}
      {allowAdd && variant !== "menu" && (
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
          onClick={chooseFiles}
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
