import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  Artifact,
  InputAttachment,
} from "../../packages/core/src/model.js";
import type { Project } from "../../packages/core/src/projects.js";
import type { SpeechScope } from "../../apps/web/src/client.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import { replaceDictationTail } from "../../apps/web/src/live-dictation.js";

// Fixed original algorithm, independently copied from Git b8db8158 App.
// Original App SHA256: 9106cd243b4c7eb160719865dbd40cd9028506f81f03e060dda7065cb6dd811f.
// Function wrappers/types only adapt the original free variables for tests.
// This fixture never imports or calls the candidate owner.
export function useFixedDictationState() {
  const dictationControls = useRef<{
    toggle(): void;
    interrupt(): void;
  } | null>(null);
  const [speechRecording, setSpeechRecording] = useState(false);
  return { dictationControls, speechRecording, setSpeechRecording };
}
export function useFixedInputMediaState() {
  const [uploadingDrafts, setUploadingDrafts] = useState<
      Record<string, boolean>
    >({}),
    [speech, setSpeech] = useState<{
      scope: SpeechScope;
      title: string;
      key: string;
      draft: InputDraft;
      modal?: boolean;
    } | null>(null),
    [capture, setCapture] = useState<{
      key: string;
      projectId: string;
      hideWindow: boolean;
      artifactId?: string;
      artifactRevision?: number;
    } | null>(null);
  return {
    uploadingDrafts,
    setUploadingDrafts,
    speech,
    setSpeech,
    capture,
    setCapture,
  };
}
export function useFixedNativeInputState() {
  const [directoryPickerScope, setDirectoryPickerScope] = useState<
    string | null
  >(null);
  const [nativeExportDialog, setNativeExportDialog] = useState(false);
  return {
    directoryPickerScope,
    setDirectoryPickerScope,
    nativeExportDialog,
    setNativeExportDialog,
  };
}
export function useFixedInputToolCommit(
  { setSpeech }: ReturnType<typeof useFixedInputMediaState>,
  { contextKey, inputVisible }: { contextKey: string; inputVisible: boolean },
) {
  useEffect(() => {
    // Do not retain a hidden recorder that could restart when returning here.
    setSpeech((current) =>
      current &&
      (current.key !== contextKey || (!current.modal && !inputVisible))
        ? null
        : current,
    );
  }, [contextKey, inputVisible]);
}

type Bindings = {
  dictationControls: ReturnType<
    typeof useFixedDictationState
  >["dictationControls"];
  media: ReturnType<typeof useFixedInputMediaState>;
  native: ReturnType<typeof useFixedNativeInputState>;
  contextKey: string;
  directoryScope: string;
  contextTitle: string;
  draft: InputDraft;
  project: Pick<Project, "id"> | undefined;
  artifact: Pick<Artifact, "id" | "revision"> | undefined;
  prefs: { artifactRevision?: number | null };
  currentContext: RefObject<string>;
  exchange: RefObject<HTMLDivElement | null>;
  input: RefObject<HTMLTextAreaElement | null>;
  setDraft(key: string, value: InputDraft): void;
  updateDraft(key: string, update: (value: InputDraft) => InputDraft): void;
  setInputErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  keepExchangeOpen(): void;
  showInput(): void;
  setInteraction(value: "input"): void;
  openObject(projectId: string, id: string): Promise<unknown>;
  requestAnimationFrame(callback: FrameRequestCallback): number;
};

export function createFixedInputToolCommands(bindings: Bindings) {
  const {
      dictationControls,
      contextKey,
      directoryScope,
      contextTitle,
      draft,
      artifact,
      prefs,
      currentContext,
      exchange,
      input,
      setDraft,
      updateDraft,
      setInputErrors,
      keepExchangeOpen,
      showInput,
      setInteraction,
      openObject,
      requestAnimationFrame,
    } = bindings,
    project = bindings.project!,
    { setUploadingDrafts, setSpeech, setCapture } = bindings.media,
    speech = bindings.media.speech!,
    capture = bindings.media.capture!,
    { setDirectoryPickerScope } = bindings.native;
  const openCapture = (hideWindow: boolean) =>
    setCapture({
      key: contextKey,
      projectId: project.id,
      hideWindow,
      ...(artifact
        ? {
            artifactId: artifact.id,
            artifactRevision:
              draft.revision ?? prefs.artifactRevision ?? artifact.revision,
          }
        : {}),
    });
  const attachmentsBusyChanged = (busy: boolean) =>
    setUploadingDrafts((old) => ({
      ...old,
      [contextKey]: busy,
    }));
  const attachmentsChanged = (
    update: (previous: InputAttachment[]) => InputAttachment[],
  ) =>
    updateDraft(contextKey, (old) => ({
      ...old,
      attachments: update(old.attachments ?? []),
    }));
  const attachmentError = (message: string) =>
    setInputErrors((old) => ({
      ...old,
      [contextKey]: message,
    }));
  const directoryError = (message: string) =>
    setInputErrors((old) => ({
      ...old,
      [contextKey]: message,
    }));
  const toggleDictation = () => {
    if (speech?.key === contextKey && !speech.modal)
      dictationControls.current?.toggle();
    else
      setSpeech({
        scope: {
          projectId: project.id,
          ...(artifact
            ? {
                artifactId: artifact.id,
                revision:
                  draft.revision ?? prefs.artifactRevision ?? artifact.revision,
              }
            : {}),
        },
        title: contextTitle,
        key: contextKey,
        draft: { ...draft },
      });
  };
  const directorySelectingChanged = (selecting: boolean) =>
    setDirectoryPickerScope((current) =>
      selecting ? directoryScope : current === directoryScope ? null : current,
    );
  const transcriptChanged = (text: string, previous: string) =>
    updateDraft(speech.key, (saved) => ({
      ...saved,
      body: replaceDictationTail(saved.body, text, previous),
      revision: speech.scope.revision ?? null,
    }));
  const transcriptInserted = (text: string) => {
    const saved = speech.draft;
    const body = [saved.body, text].filter(Boolean).join("\n");
    if (body.length > 30000)
      throw new Error(
        "这段文字超过单条消息长度，请先保存为文档，再围绕文档输入；文字不会被截断。",
      );
    setDraft(speech.key, {
      ...saved,
      body,
      revision: speech.scope.revision ?? null,
    });
    setSpeech(null);
    setInteraction("input");
    requestAnimationFrame(() => input.current?.focus());
  };
  function closeSpeech() {
    dictationControls.current?.interrupt();
    if (speech && !speech.modal && speech.key === currentContext.current) {
      // Restore a stable control before the inline close button unmounts.
      // Closing dictation is not leaving the surrounding composer.
      keepExchangeOpen();
      exchange.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]')
        ?.focus();
    }
    setSpeech(null);
  }
  const closeCapture = () => setCapture(null);
  const captureAttached = (attachment: InputAttachment) => {
    const key = capture.key;
    updateDraft(key, (old) => ({
      ...old,
      attachments: [...(old.attachments ?? []), attachment],
    }));
    setCapture(null);
    if (currentContext.current === key) showInput();
  };
  const captureSaved = (id: string) => {
    const projectId = capture.projectId;
    setCapture(null);
    void openObject(projectId, id);
  };
  return {
    openCapture,
    attachmentsBusyChanged,
    attachmentsChanged,
    attachmentError,
    directoryError,
    toggleDictation,
    directorySelectingChanged,
    transcriptChanged,
    transcriptInserted,
    closeSpeech,
    closeCapture,
    captureAttached,
    captureSaved,
  };
}
