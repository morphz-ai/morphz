import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  Artifact,
  InputAttachment,
} from "../../../../packages/core/src/model.js";
import type { Project } from "../../../../packages/core/src/projects.js";
import type { SpeechScope } from "../client.js";
import { replaceDictationTail } from "../live-dictation.js";
import type { InputDraft } from "./exchange-drafts.js";

type SpeechScene = {
  scope: SpeechScope;
  title: string;
  key: string;
  draft: InputDraft;
  modal?: boolean;
};
type CaptureScene = {
  key: string;
  projectId: string;
  hideWindow: boolean;
  artifactId?: string;
  artifactRevision?: number;
};

/** The three groups register at their original Host seams; their order must
 * not pull an input-tool state across an unrelated Host lifecycle. */
export function useExchangeDictationState() {
  const dictationControls = useRef<{
    toggle(): void;
    interrupt(): void;
  } | null>(null);
  const [speechRecording, setSpeechRecording] = useState(false);
  return { dictationControls, speechRecording, setSpeechRecording };
}

export function useExchangeInputMediaState() {
  const [uploadingDrafts, setUploadingDrafts] = useState<
      Record<string, boolean>
    >({}),
    [speech, setSpeech] = useState<SpeechScene | null>(null),
    [capture, setCapture] = useState<CaptureScene | null>(null);
  return {
    uploadingDrafts,
    setUploadingDrafts,
    speech,
    setSpeech,
    capture,
    setCapture,
  };
}

export function useExchangeNativeInputState() {
  const [directoryPickerScope, setDirectoryPickerScope] = useState<
      string | null
    >(null),
    [nativeExportDialog, setNativeExportDialog] = useState(false);
  return {
    directoryPickerScope,
    setDirectoryPickerScope,
    nativeExportDialog,
    setNativeExportDialog,
  };
}

type DictationState = ReturnType<typeof useExchangeDictationState>;
type MediaState = ReturnType<typeof useExchangeInputMediaState>;
type NativeState = ReturnType<typeof useExchangeNativeInputState>;

export type ExchangeInputToolCloseOptions = {
  dictation: Readonly<Pick<DictationState, "dictationControls">>;
  media: Readonly<Pick<MediaState, "speech" | "setSpeech">>;
  currentContext: Readonly<Pick<RefObject<string>, "current">>;
  keepExchangeOpen(): void;
  focusMicrophone(): void;
};

/** Construct at the original early close/keyboard seam. This does not borrow
 * any later context title, project or draft, or invoke a port at construction. */
export function createExchangeInputToolCloseCommand({
  dictation,
  media,
  currentContext,
  keepExchangeOpen,
  focusMicrophone,
}: ExchangeInputToolCloseOptions) {
  return function closeSpeech() {
    dictation.dictationControls.current?.interrupt();
    const { speech } = media;
    if (speech && !speech.modal && speech.key === currentContext.current) {
      keepExchangeOpen();
      focusMicrophone();
    }
    media.setSpeech(null);
  };
}

export function useExchangeInputToolCommit(
  { setSpeech }: MediaState,
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

export type ExchangeInputToolOptions = {
  closeSpeech: ReturnType<typeof createExchangeInputToolCloseCommand>;
  dictation: Readonly<DictationState>;
  media: Readonly<MediaState>;
  native: Readonly<NativeState>;
  render: Readonly<{
    contextKey: string;
    directoryScope: string;
    contextTitle: string;
    draft: InputDraft;
    project: Pick<Project, "id"> | undefined;
    artifact: Pick<Artifact, "id" | "revision"> | undefined;
    preferences: Readonly<{ artifactRevision?: number | null }>;
  }>;
  drafts: {
    replace(key: string, value: InputDraft): void;
    update(key: string, update: (value: InputDraft) => InputDraft): void;
  };
  currentContext: Readonly<Pick<RefObject<string>, "current">>;
  exchange: {
    showInput(): void;
    setInteraction(value: "input"): void;
  };
  focus: {
    scheduleInput(): void;
  };
  openSavedCapture(projectId: string, id: string): void;
  reportInputError(key: string, message: string): void;
};

/** Capture this render's scenes and draft. Construction invokes no port and
 * reads no ref/project. Acquisition, authorization and DOM scheduling remain
 * in their existing features/Host; only originating-draft delivery lives here. */
export function createExchangeInputToolCommands({
  closeSpeech,
  dictation,
  media,
  native,
  render,
  drafts,
  currentContext,
  exchange,
  focus,
  openSavedCapture,
  reportInputError,
}: ExchangeInputToolOptions) {
  function openCapture(hideWindow: boolean) {
    const { contextKey, project, artifact, draft, preferences: prefs } = render;
    media.setCapture({
      key: contextKey,
      projectId: project!.id,
      hideWindow,
      ...(artifact
        ? {
            artifactId: artifact.id,
            artifactRevision:
              draft.revision ?? prefs.artifactRevision ?? artifact.revision,
          }
        : {}),
    });
  }
  function attachmentsBusyChanged(busy: boolean) {
    media.setUploadingDrafts((old) => ({
      ...old,
      [render.contextKey]: busy,
    }));
  }
  function attachmentsChanged(
    update: (previous: InputAttachment[]) => InputAttachment[],
  ) {
    drafts.update(render.contextKey, (old) => ({
      ...old,
      attachments: update(old.attachments ?? []),
    }));
  }
  function attachmentError(message: string) {
    reportInputError(render.contextKey, message);
  }
  function toggleDictation() {
    const { contextKey, contextTitle, project, artifact, draft } = render,
      prefs = render.preferences,
      { speech } = media;
    if (speech?.key === contextKey && !speech.modal)
      dictation.dictationControls.current?.toggle();
    else
      media.setSpeech({
        scope: {
          projectId: project!.id,
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
  }
  function directorySelectingChanged(selecting: boolean) {
    native.setDirectoryPickerScope((current) =>
      selecting
        ? render.directoryScope
        : current === render.directoryScope
          ? null
          : current,
    );
  }
  function transcriptChanged(text: string, previous: string) {
    const speech = media.speech!;
    drafts.update(speech.key, (saved) => ({
      ...saved,
      body: replaceDictationTail(saved.body, text, previous),
      revision: speech.scope.revision ?? null,
    }));
  }
  function transcriptInserted(text: string) {
    const speech = media.speech!,
      saved = speech.draft;
    const body = [saved.body, text].filter(Boolean).join("\n");
    if (body.length > 30000)
      throw new Error(
        "这段文字超过单条消息长度，请先保存为文档，再围绕文档输入；文字不会被截断。",
      );
    drafts.replace(speech.key, {
      ...saved,
      body,
      revision: speech.scope.revision ?? null,
    });
    media.setSpeech(null);
    exchange.setInteraction("input");
    focus.scheduleInput();
  }
  function closeCapture() {
    media.setCapture(null);
  }
  function captureAttached(attachment: InputAttachment) {
    const key = media.capture!.key;
    drafts.update(key, (old) => ({
      ...old,
      attachments: [...(old.attachments ?? []), attachment],
    }));
    media.setCapture(null);
    if (currentContext.current === key) exchange.showInput();
  }
  function captureSaved(id: string) {
    const projectId = media.capture!.projectId;
    media.setCapture(null);
    openSavedCapture(projectId, id);
  }
  return {
    openCapture,
    attachmentsBusyChanged,
    attachmentsChanged,
    attachmentError,
    directorySelectingChanged,
    toggleDictation,
    transcriptChanged,
    transcriptInserted,
    closeSpeech,
    closeCapture,
    captureAttached,
    captureSaved,
  };
}
