import React, {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  createExchangeInputToolCommands,
  createExchangeInputToolCloseCommand,
  useExchangeDictationState,
  useExchangeInputMediaState,
  useExchangeInputToolCommit,
  useExchangeNativeInputState,
} from "../../apps/web/src/host/use-exchange-input-tools.js";
import {
  createFixedInputToolCommands,
  useFixedDictationState,
  useFixedInputMediaState,
  useFixedInputToolCommit,
  useFixedNativeInputState,
} from "./exchange-input-tools-b8db8158.js";
import { MessageAttachments } from "../../apps/web/src/MessageAttachments.js";
import {
  AgentDirectories,
  type DirectoryState,
} from "../../apps/web/src/AgentDirectories.js";
import { SpeechDialog } from "../../apps/web/src/SpeechDialog.js";
import { CaptureDialog } from "../../apps/web/src/CaptureDialog.js";
import {
  replaceComposerSurface,
  updateComposerDraft,
} from "../../apps/web/src/composer-drafts.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type {
  SpeechScope,
  WorkspaceClient,
} from "../../apps/web/src/client.js";
import type { SpeechStreamState } from "../../packages/core/src/speech-stream.js";

// This is a bounded, synthetic acquisition fixture, not App/HTTP/Runtime or
// permission evidence. Actual feature hooks, DOM, portal, audio and cancellation
// run in a private browser page; their external transports are controlled.
const h = React.createElement;
const empty: InputDraft = { body: "", selection: "", revision: null };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWOQ0zD6DwACWAF492PbxQAAAABJRU5ErkJggg==";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function mountInputToolsFixture(mode: "fixed" | "production") {
  const domain = {
    uploads: [] as string[],
    uploadHeld: false,
    uploadPending: [] as ReturnType<
      typeof deferred<{ assetId: string; mime: string }>
    >[],
    captureRequests: [] as { hideWindow: boolean }[],
    captures: [] as ReturnType<
      typeof deferred<{ mime: "image/png"; data: string } | null>
    >[],
    captureCancels: 0,
    directories: [] as string[],
    directoryPending: [] as ReturnType<typeof deferred<null>>[],
    calls: [] as string[],
    streams: [] as {
      scope: SpeechScope;
      state: SpeechStreamState;
      reads: ReturnType<typeof deferred<SpeechStreamState>>[];
    }[],
    executions: [] as unknown[],
  };
  const transport = {
    voice: {
      requestMicrophone: async () => true,
      cancelMicrophone: async () => {},
    },
    application: {
      invoke: async (request: { id: string; method: string }) => {
        domain.calls.push(request.method);
        if (request.method !== "directories.list")
          throw Error("No other application operation is allowed");
        return { id: request.id, ok: true, value: [] };
      },
      cancel: () => {},
    },
    directories: {
      choose: async (projectId: string, conversationId: string) => {
        domain.directories.push(projectId + ":" + conversationId);
        const pending = deferred<null>();
        domain.directoryPending.push(pending);
        return pending.promise;
      },
    },
    capture: {
      select: async (options: { hideWindow: boolean }) => {
        domain.captureRequests.push(options);
        const pending = deferred<{ mime: "image/png"; data: string } | null>();
        domain.captures.push(pending);
        return pending.promise;
      },
      cancel: async () => {
        domain.captureCancels++;
        for (const pending of domain.captures.splice(0)) pending.resolve(null);
      },
    },
  };
  window.morphzDesktop = transport as unknown as NonNullable<
    typeof window.morphzDesktop
  >;
  const client = {
    async uploadAttachment(file: File) {
      domain.uploads.push(file.name);
      if (domain.uploadHeld) {
        const pending = deferred<{ assetId: string; mime: string }>();
        domain.uploadPending.push(pending);
        return pending.promise;
      }
      return { assetId: "asset-" + file.name, mime: file.type };
    },
    upload: async () => ({ assetId: "saved-image" }),
    execute: async (command: unknown) => {
      domain.executions.push(command);
      return { entityId: "saved-object" };
    },
    speechStatus: async () => ({
      configured: true,
      provider: "fixture",
      providerLabel: "Controlled fixture",
      streaming: true,
    }),
    transcribe: async () => "controlled transcription",
    createSpeechStream(scope: SpeechScope) {
      const stream = {
        scope,
        state: {
          id: "00000000-0000-4000-8000-000000000001",
          revision: 0,
          text: "",
          status: "listening",
        } as SpeechStreamState,
        reads: [] as ReturnType<typeof deferred<SpeechStreamState>>[],
      };
      domain.streams.push(stream);
      return async (command: { action: string }, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (command.action === "read") {
          const pending = deferred<SpeechStreamState>();
          stream.reads.push(pending);
          return new Promise<SpeechStreamState>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            pending.promise.then((value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            });
          });
        }
        if (command.action === "finish" || command.action === "cancel") {
          stream.state = {
            ...stream.state,
            revision: stream.state.revision + 1,
            status: command.action === "finish" ? "complete" : "cancelled",
          };
          for (const pending of stream.reads.splice(0))
            pending.resolve(stream.state);
        }
        return stream.state;
      };
    },
  } as unknown as WorkspaceClient;
  let latest!: {
    report(): unknown;
    run(action: string, value: unknown): void;
  };
  const closed: unknown[][] = [];
  function Lane() {
    const [contextKey, setKey] = useState("A:object"),
      [visible, setVisible] = useState(true),
      [tick, setTick] = useState(0);
    const dictation =
      mode === "fixed" ? useFixedDictationState() : useExchangeDictationState();
    const [notice] = useState("unmigrated registration");
    const media =
      mode === "fixed"
        ? useFixedInputMediaState()
        : useExchangeInputMediaState();
    const [directoryState, setDirectoryState] = useState<DirectoryState>({
      scope: "",
      ready: false,
      grants: [],
    });
    const native =
      mode === "fixed"
        ? useFixedNativeInputState()
        : useExchangeNativeInputState();
    const [stored, writeDrafts] = useState<Record<string, InputDraft>>({
        "A:object": { ...empty, body: "original" },
        "B:object": { ...empty, body: "other scene" },
      }),
      [inputErrors, setInputErrors] = useState<Record<string, string>>({}),
      [attachmentSlot, setAttachmentSlot] = useState<HTMLDivElement | null>(
        null,
      ),
      [dictationSlot, setDictationSlot] = useState<HTMLDivElement | null>(null);
    const input = useRef<HTMLTextAreaElement>(null),
      exchange = useRef<HTMLDivElement>(null),
      currentContext = useRef(contextKey),
      ledger = useRef<unknown[][]>([]);
    currentContext.current = contextKey;
    const first = useRef({
      controls: dictation.dictationControls,
      recording: dictation.setSpeechRecording,
      native: native.setNativeExportDialog,
    });
    const [projectId, conversationId] = contextKey.startsWith("A")
        ? ["project-A", "A"]
        : ["project-B", "B"],
      directoryScope = projectId + ":" + conversationId,
      draft = stored[contextKey]!,
      artifact = { id: "object", revision: 9 },
      prefs = { artifactRevision: 8 };
    const setDraft = (key: string, value: InputDraft) => {
      if (key === currentContext.current && value.body !== stored[key]?.body)
        dictation.dictationControls.current?.interrupt();
      ledger.current.push(["draft-replace", key, value]);
      writeDrafts((previous) =>
        replaceComposerSurface(previous, key, empty, value),
      );
    };
    const updateDraft = (
      key: string,
      update: (value: InputDraft) => InputDraft,
    ) => {
      ledger.current.push(["draft-update", key]);
      writeDrafts((previous) =>
        updateComposerDraft(previous, key, empty, update, empty),
      );
    };
    const keepExchangeOpen = () => ledger.current.push(["keep-open"]),
      showInput = () => {
        ledger.current.push(["show-input"]);
        setVisible(true);
      },
      setInteraction = (value: "input") =>
        ledger.current.push(["interaction", value]),
      openObject = (capturedProjectId: string, id: string) => {
        ledger.current.push(["open-object", capturedProjectId, id]);
        return Promise.resolve();
      };
    const fixedBindings = {
      dictationControls: dictation.dictationControls,
      media,
      native,
      contextKey,
      directoryScope,
      contextTitle: "not consumed by early close",
      draft,
      project: { id: projectId },
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
    };
    // Early command uses only the old close free variables. Its exact identity
    // is borrowed by both the fixture keyboard consumer and actual Dialog.
    const closeSpeech =
      mode === "fixed"
        ? createFixedInputToolCommands(fixedBindings).closeSpeech
        : createExchangeInputToolCloseCommand({
            dictation,
            media,
            currentContext,
            keepExchangeOpen,
            focusMicrophone: () => {
              exchange.current
                ?.querySelector<HTMLButtonElement>(
                  'button[aria-label="语音输入"]',
                )
                ?.focus();
            },
          });
    const contextTitle = "Original scene";
    const commands =
      mode === "fixed"
        ? {
            ...createFixedInputToolCommands({ ...fixedBindings, contextTitle }),
            closeSpeech,
          }
        : createExchangeInputToolCommands({
            closeSpeech,
            dictation,
            media,
            native,
            render: {
              contextKey,
              directoryScope,
              contextTitle,
              draft,
              project: { id: projectId },
              artifact,
              preferences: prefs,
            },
            currentContext,
            drafts: { replace: setDraft, update: updateDraft },
            exchange: { showInput, setInteraction },
            focus: {
              scheduleInput: () => {
                requestAnimationFrame(() => input.current?.focus());
              },
            },
            openSavedCapture: (capturedProjectId, id) => {
              void openObject(capturedProjectId, id);
            },
            reportInputError: (key, message) =>
              setInputErrors((old) => ({ ...old, [key]: message })),
          });
    useLayoutEffect(() => {
      ledger.current.push(["navigation-commit", contextKey]);
    }, [contextKey]);
    useLayoutEffect(() => {
      ledger.current.push(["exchange-focus", contextKey]);
    }, [contextKey]);
    if (mode === "fixed")
      useFixedInputToolCommit(media, { contextKey, inputVisible: visible });
    else
      useExchangeInputToolCommit(media, { contextKey, inputVisible: visible });
    useEffect(() => {
      ledger.current.push(["after-tool-commit", contextKey, visible]);
    }, [contextKey, visible]);
    useEffect(() => {
      // Only the unchanged Host Escape branch is exercised here. Other App
      // keyboard/navigation responsibilities are not replaced by this fixture.
      const keyboard = (event: KeyboardEvent) => {
        if (
          event.isComposing ||
          event.keyCode === 229 ||
          event.defaultPrevented
        )
          return;
        if (document.querySelector("dialog[open]")) return;
        if (event.key === "Escape" && media.speech && !media.speech.modal) {
          event.preventDefault();
          closeSpeech();
        }
      };
      document.addEventListener("keydown", keyboard);
      return () => document.removeEventListener("keydown", keyboard);
    }, [media.speech, closeSpeech]);
    useEffect(
      () => () => {
        closed.push(["unmount"]);
      },
      [],
    );
    latest = {
      report: () => ({
        contextKey,
        visible,
        tick,
        notice,
        stored,
        inputErrors,
        directoryState,
        media: {
          speech: media.speech,
          capture: media.capture,
          uploadingDrafts: media.uploadingDrafts,
        },
        native: {
          directoryPickerScope: native.directoryPickerScope,
          nativeExportDialog: native.nativeExportDialog,
        },
        recording: dictation.speechRecording,
        controlsAttached: dictation.dictationControls.current !== null,
        stable: {
          controls: first.current.controls === dictation.dictationControls,
          recording: first.current.recording === dictation.setSpeechRecording,
          native: first.current.native === native.setNativeExportDialog,
          closeAlias: commands.closeSpeech === closeSpeech,
        },
        ledger: ledger.current,
        active: document.activeElement?.getAttribute("aria-label"),
        domain: {
          uploads: domain.uploads,
          captureRequests: domain.captureRequests,
          captureCancels: domain.captureCancels,
          directories: domain.directories,
          calls: domain.calls,
          streamScopes: domain.streams.map((s) => s.scope),
          streams: domain.streams.map((s) => ({
            state: s.state,
            pendingReads: s.reads.length,
          })),
          executions: domain.executions,
        },
        closed,
      }),
      run(action, value) {
        if (action === "scope") setKey(String(value));
        else if (action === "visible") setVisible(Boolean(value));
        else if (action === "tick") setTick((old) => old + 1);
        else if (action === "native")
          native.setNativeExportDialog(Boolean(value));
        else if (action === "modal")
          media.setSpeech({
            scope: { projectId, artifactId: "object", revision: 7 },
            title: "Seeded retained branch",
            key: contextKey,
            draft: { ...draft },
            modal: true,
          });
      },
    };
    const speech = media.speech,
      capture = media.capture,
      uploading = !!media.uploadingDrafts[contextKey];
    return h(
      "main",
      { className: "workspace" },
      h(
        "section",
        { ref: exchange, className: "exchange-panel" },
        visible &&
          h(
            "div",
            { className: "composer" },
            h("textarea", {
              ref: input,
              "aria-label": "AI 输入内容",
              value: draft.body,
              onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
                setDraft(contextKey, { ...draft, body: event.target.value }),
            }),
            h("div", { ref: setAttachmentSlot }),
            h("div", { ref: setDictationSlot }),
            h(MessageAttachments, {
              key: "attachments:" + contextKey,
              variant: "menu",
              client,
              inputRef: input,
              previewTarget: attachmentSlot,
              attachments: draft.attachments ?? [],
              allowAdd: true,
              disabled: uploading,
              onBusy: commands.attachmentsBusyChanged,
              onChange: commands.attachmentsChanged,
              onError: commands.attachmentError,
              capture: { disabled: uploading, onSelect: commands.openCapture },
            }),
            h(
              "button",
              {
                "aria-label": "语音输入",
                "aria-pressed": dictation.speechRecording,
                onClick: commands.toggleDictation,
              },
              "Microphone",
            ),
            h(AgentDirectories, {
              key: "fixture:" + directoryScope,
              variant: "settings",
              projectId,
              conversationId,
              identity: "fixture-generation",
              previewTarget: null,
              disabled: false,
              onSelecting: commands.directorySelectingChanged,
              onState: setDirectoryState,
              onError: commands.attachmentError,
            }),
          ),
      ),
      speech &&
        (speech.modal || dictationSlot) &&
        speech.key === contextKey &&
        h(SpeechDialog, {
          key:
            speech.key + ":" + (speech.modal ? "transcription" : "dictation"),
          client,
          controls: speech.modal ? undefined : dictation.dictationControls,
          onRecording: speech.modal ? undefined : dictation.setSpeechRecording,
          inlineTarget: speech.modal ? undefined : dictationSlot!,
          transcriptLimit: 30000 - draft.body.length - (draft.body ? 1 : 0),
          scope: speech.scope,
          title: speech.title,
          onClose: commands.closeSpeech,
          onTranscript: speech.modal ? undefined : commands.transcriptChanged,
          onInsert: commands.transcriptInserted,
        }),
      capture &&
        h(CaptureDialog, {
          client,
          ...capture,
          onClose: commands.closeCapture,
          onAttach: commands.captureAttached,
          onSaved: commands.captureSaved,
        }),
      h(
        "output",
        { "data-tick": tick },
        JSON.stringify({
          recording: dictation.speechRecording,
          picker: native.directoryPickerScope,
          uploading,
          native: native.nativeExportDialog,
        }),
      ),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  Reflect.set(window, "inputToolFixture", {
    run(action: string, value: unknown = null) {
      flushSync(() => latest.run(action, value));
    },
    report() {
      return latest.report();
    },
    holdUpload() {
      domain.uploadHeld = true;
    },
    releaseUpload() {
      domain.uploadHeld = false;
      for (const pending of domain.uploadPending.splice(0))
        pending.resolve({ assetId: "asset-late.txt", mime: "text/plain" });
    },
    finishCapture(value: boolean) {
      for (const pending of domain.captures.splice(0))
        pending.resolve(value ? { mime: "image/png", data: png } : null);
    },
    finishDirectory() {
      domain.directoryPending.shift()?.resolve(null);
    },
    publish(text: string) {
      const stream = domain.streams.at(-1)!;
      stream.state = {
        ...stream.state,
        revision: stream.state.revision + 1,
        text,
      };
      for (const pending of stream.reads.splice(0))
        pending.resolve(stream.state);
    },
    unmount() {
      flushSync(() => root.unmount());
    },
  });
  root.render(h(StrictMode, null, h(Lane)));
}
