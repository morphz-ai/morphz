import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isArrayBindingPattern,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import {
  createExchangeInputToolCommands,
  createExchangeInputToolCloseCommand,
  type ExchangeInputToolCloseOptions,
  type ExchangeInputToolOptions,
} from "../apps/web/src/host/use-exchange-input-tools.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import {
  replaceComposerSurface,
  updateComposerDraft,
} from "../apps/web/src/composer-drafts.js";
import type { InputAttachment } from "../packages/core/src/model.js";
import { createFixedInputToolCommands } from "./fixtures/exchange-input-tools-b8db8158.js";

type Media = ExchangeInputToolOptions["media"];
type Native = ExchangeInputToolOptions["native"];
type State = {
  speech: Media["speech"];
  capture: Media["capture"];
  uploadingDrafts: Media["uploadingDrafts"];
  directoryPickerScope: Native["directoryPickerScope"];
  nativeExportDialog: boolean;
  speechRecording: boolean;
};
const empty: InputDraft = { body: "", selection: "", revision: null };
const attachment: InputAttachment = {
  assetId: "asset-new",
  mime: "text/plain",
  name: "new.txt",
};
const scene = (
  draft: InputDraft,
  modal = false,
): NonNullable<Media["speech"]> => ({
  key: "A:object",
  title: "Original scene",
  scope: { projectId: "project-A", artifactId: "object", revision: 7 },
  draft,
  ...(modal ? { modal } : {}),
});
const capture = (): NonNullable<Media["capture"]> => ({
  key: "A:object",
  projectId: "project-A",
  hideWindow: false,
  artifactId: "object",
  artifactRevision: 7,
});

// Independently calculated from the fixed Git b8db8158 source, never from the
// candidate. These cover every original registration/effect/handler subtree.
const fixedDigests = {
  dictationControls:
    "12d93c0357ecd1a0db43ac8c55691873a012aecfdc8c5d83b2d5356fb4885b67",
  speechRecording:
    "23efa79dbf8fe3b878ead2d4a95fa009d7eabfe70ffb5bda7483588b5c224bbe",
  uploadingDrafts:
    "76cc08489062699b5ba368a6d16107e97789f14a61bce8d09ab52181dbf0dd8a",
  speech: "859aca44b9721464271d64e4704ab6100fbbb5de0b1fa7855dcb8197cd054ce7",
  capture: "e687f3a5b23b3dbbdbfcba904316f38cd4a0d683f1974c25a7c6112cf7faa5cc",
  directoryPickerScope:
    "1899fd8936ccf2929896c34590ef8056e3c1c64b432b6b6619191a47bda18bc0",
  nativeExportDialog:
    "23efa79dbf8fe3b878ead2d4a95fa009d7eabfe70ffb5bda7483588b5c224bbe",
  retirement:
    "60a5d7a3115c8a631e22833b9060a22d1236f7d539b2338ab378fbe5e5131fb9",
  openCapture:
    "4e29beec5d5d2e62b26342ae81caefc9cbc48714197a7aaee87b97607d5165ee",
  attachmentsBusyChanged:
    "6f7f8236719ce32b2424202911251c5733e83819b58c6176a91f8f392874ea74",
  attachmentsChanged:
    "68d4b4c1958f1fcf88f3d2976e57d7d99ca4f16861203be1b9cf068e65fb69ab",
  attachmentError:
    "38ad2cca983d9fc4d022e9142018a9b9b15cc7592ea522343c84d066d56c09ba",
  toggleDictation:
    "479dbe0210f294bf867fa07714556bdc306cd415597e2a1b1f551cfc9048eaed",
  directorySelectingChanged:
    "35c0b1a03c323222b260553baab83139e99dd4f50c9b3ca08308e05177890177",
  directoryError:
    "38ad2cca983d9fc4d022e9142018a9b9b15cc7592ea522343c84d066d56c09ba",
  transcriptChanged:
    "d1a3a508de83bc4a3b81522d1757f793b9898530f95e3c854caa52f1b2321dcb",
  transcriptInserted:
    "bf74826dfa0c9d338478868a0b92ba83a88e3c7542d1b0460ad31fe286909b13",
  closeCapture:
    "2f06faf1c51ee4f65fd6f6febc30bcda726b4a0d6daac540b593a32f058ccc0f",
  captureAttached:
    "40c880d3b18a49cef36e828cacbaa23faa677c36783d0c49329db588e13e040a",
  captureSaved:
    "4cf797f70b23636b7937b05347ad88ebb2b9fbcfcf87ccfa28b1e8698c9a4478",
  closeSpeech:
    "7de3ea52876749b86ff3bf236905ef1ca989dda3031b616cf92b861b4a17a8a4",
};
function verifyFixedOracle(source: string) {
  const directory = "/fixed-exchange-input-tool-oracle",
    config = directory + "/tsconfig.json",
    file = directory + "/fixed.ts";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [file]: source,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["fixed.ts"],
      }),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)!.program,
        parsed = program.getSourceFile(file)!;
      assert.deepEqual(program.getSyntacticDiagnostics(), []);
      const actual: Record<string, string> = {},
        hooks: string[] = [];
      function shape(node: Node, sourceFile: SourceFile): unknown {
        const children: unknown[] = [];
        node.forEachChild((child) => {
          children.push(shape(child, sourceFile));
        });
        return [
          node.kind,
          ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
            ? [node.operator]
            : []),
          ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
          children.length ? children : node.getText(sourceFile),
        ];
      }
      const digest = (node: Node) =>
        createHash("sha256")
          .update(JSON.stringify(shape(node, parsed)))
          .digest("hex");
      function walk(node: Node) {
        if (isVariableDeclaration(node) && node.initializer) {
          const name = isIdentifier(node.name)
            ? node.name.text
            : isArrayBindingPattern(node.name)
              ? node.name.elements[0]?.getText(parsed)
              : undefined;
          if (name && name in fixedDigests) {
            if (isArrowFunction(node.initializer))
              actual[name] = digest(node.initializer.body);
            else if (isCallExpression(node.initializer)) {
              actual[name] = digest(node.initializer);
              hooks.push(name);
            }
          }
        }
        if (
          isCallExpression(node) &&
          isIdentifier(node.expression) &&
          node.expression.text === "useEffect"
        )
          actual.retirement = digest(node);
        if (isFunctionDeclaration(node) && node.name?.text === "closeSpeech")
          actual.closeSpeech = digest(node.body!);
        node.forEachChild((child) => {
          walk(child);
        });
      }
      walk(parsed);
      assert.deepEqual(hooks, [
        "dictationControls",
        "speechRecording",
        "uploadingDrafts",
        "speech",
        "capture",
        "directoryPickerScope",
        "nativeExportDialog",
      ]);
      assert.deepEqual(actual, fixedDigests);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
test("fixed oracle retains all 21 independently frozen Git b8db registration/effect/handler trees", () => {
  verifyFixedOracle(
    readFileSync("tests/fixtures/exchange-input-tools-b8db8158.ts", "utf8"),
  );
});
test("fixed oracle proof rejects drift in later siblings, scope guards and hook initialization", () => {
  const fixed = readFileSync(
    "tests/fixtures/exchange-input-tools-b8db8158.ts",
    "utf8",
  );
  for (const changed of [
    fixed.replace(
      "void openObject(projectId, id);",
      "void openObject('new-project', id);",
    ),
    fixed.replace("current === directoryScope", "current !== directoryScope"),
    fixed.replace(
      "useState(false);\n  return {\n    directoryPickerScope",
      "useState(true);\n  return {\n    directoryPickerScope",
    ),
    fixed.replace(
      "requestAnimationFrame(() => input.current?.focus());",
      "requestAnimationFrame(() => input.current?.focus({preventScroll:true}));",
    ),
  ]) {
    assert.notEqual(changed, fixed, "mutation must hit original fixed source");
    assert.throws(() => verifyFixedOracle(changed), { name: "AssertionError" });
  }
});

/** Only synchronous React setters/Host ports are controlled here. The fixed
 * algorithm and candidate receive independent state and the same old writers. */
function lane(
  mode: "fixed" | "production",
  initial: Partial<State> = {},
  initialDraft: InputDraft = { ...empty, body: "original" },
) {
  const events: unknown[][] = [],
    frames: FrameRequestCallback[] = [];
  let fail = "";
  const event = (name: string, ...values: unknown[]) => {
    events.push([name, ...values]);
    if (fail === name) throw new Error("port failed: " + name);
  };
  const state: State = {
    speech: null,
    capture: null,
    uploadingDrafts: {},
    directoryPickerScope: null,
    nativeExportDialog: false,
    speechRecording: false,
    ...initial,
  };
  let drafts: Record<string, InputDraft> = {
      "A:object": initialDraft,
      "B:object": { ...empty, body: "other scene" },
    },
    errors: Record<string, string> = { "B:object": "untouched" };
  const currentContext = { current: "A:object" };
  const dictationControls = {
    current: {
      toggle: () => event("toggle"),
      interrupt: () => event("interrupt"),
    },
  };
  function setter<K extends keyof State>(
    name: K,
  ): Dispatch<SetStateAction<State[K]>> {
    return (update) => {
      const next =
        typeof update === "function"
          ? (update as (value: State[K]) => State[K])(state[name])
          : update;
      event("state:" + name, next);
      state[name] = next;
    };
  }
  const setSpeech = setter("speech"),
    setCapture = setter("capture"),
    setUploadingDrafts = setter("uploadingDrafts"),
    setSpeechRecording = setter("speechRecording"),
    setDirectoryPickerScope = setter("directoryPickerScope"),
    setNativeExportDialog = setter("nativeExportDialog");
  const input = {
    current: { focus: () => event("input-focus", "first") },
  } as unknown as RefObject<HTMLTextAreaElement | null>;
  const exchange = {
    current: {
      querySelector: (selector: string) => {
        event("query", selector);
        return { focus: () => event("microphone-focus") };
      },
    },
  } as unknown as RefObject<HTMLDivElement | null>;
  const requestFrame = (callback: FrameRequestCallback) => {
    event("frame");
    return frames.push(callback);
  };
  const keepExchangeOpen = () => event("keep-open"),
    showInput = () => event("show-input"),
    setInteraction = (value: "input") => event("interaction", value),
    openObject = (projectId: string, id: string) => {
      event("open-object", projectId, id);
      return Promise.resolve(undefined);
    };
  const setInputErrors: Dispatch<SetStateAction<Record<string, string>>> = (
    update,
  ) => {
    const next = typeof update === "function" ? update(errors) : update;
    event("errors", next);
    errors = next;
  };
  function commands(change: Partial<ExchangeInputToolOptions["render"]> = {}) {
    const renderedDrafts = drafts;
    const render: ExchangeInputToolOptions["render"] = {
      contextKey: "A:object",
      directoryScope: "project-A:A",
      contextTitle: "Original scene",
      project: { id: "project-A" },
      artifact: { id: "object", revision: 9 },
      preferences: { artifactRevision: 8 },
      draft: renderedDrafts["A:object"]!,
      ...change,
    };
    function setDraft(key: string, value: InputDraft) {
      if (
        key === currentContext.current &&
        value.body !== renderedDrafts[key]?.body
      )
        dictationControls.current?.interrupt();
      event("draft-replace", key, value);
      drafts = replaceComposerSurface(drafts, key, empty, value);
    }
    function updateDraft(
      key: string,
      update: (value: InputDraft) => InputDraft,
    ) {
      event("draft-update", key);
      drafts = updateComposerDraft(drafts, key, empty, update, empty);
    }
    const media: Media = {
      speech: state.speech,
      capture: state.capture,
      uploadingDrafts: state.uploadingDrafts,
      setSpeech,
      setCapture,
      setUploadingDrafts,
    };
    const native: Native = {
      directoryPickerScope: state.directoryPickerScope,
      nativeExportDialog: state.nativeExportDialog,
      setDirectoryPickerScope,
      setNativeExportDialog,
    };
    if (mode === "fixed")
      return createFixedInputToolCommands({
        ...render,
        prefs: render.preferences,
        dictationControls,
        media,
        native,
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
        requestAnimationFrame: requestFrame,
      });
    const options: ExchangeInputToolOptions = {
      closeSpeech: createExchangeInputToolCloseCommand({
        dictation: { dictationControls },
        media,
        currentContext,
        keepExchangeOpen,
        focusMicrophone: () =>
          exchange.current
            ?.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]')
            ?.focus(),
      }),
      dictation: {
        dictationControls,
        speechRecording: state.speechRecording,
        setSpeechRecording,
      },
      media,
      native,
      render,
      currentContext,
      drafts: { replace: setDraft, update: updateDraft },
      exchange: { showInput, setInteraction },
      focus: {
        scheduleInput: () => {
          requestFrame(() => input.current?.focus());
        },
      },
      openSavedCapture: (projectId, id) => {
        void openObject(projectId, id);
      },
      reportInputError: (key, message) =>
        setInputErrors((old) => ({ ...old, [key]: message })),
    };
    const commands = createExchangeInputToolCommands(options);
    return { ...commands, directoryError: commands.attachmentError };
  }
  return {
    state,
    events,
    currentContext,
    dictationControls,
    input,
    commands,
    failAt: (name: string) => {
      fail = name;
    },
    updateStored: (key: string, value: InputDraft) => {
      drafts = { ...drafts, [key]: value };
    },
    drafts: () => drafts,
    report: () => ({ state, drafts, errors, events }),
    flushFrames: () => {
      while (frames.length) frames.shift()!(0);
    },
  };
}
type Lane = ReturnType<typeof lane>;
function pair(initial: Partial<State> = {}, draft?: InputDraft) {
  return [
    lane("fixed", structuredClone(initial), draft && structuredClone(draft)),
    lane(
      "production",
      structuredClone(initial),
      draft && structuredClone(draft),
    ),
  ] as const;
}
function parity(lanes: readonly Lane[]) {
  assert.deepEqual(lanes[1]!.report(), lanes[0]!.report());
}

test("input-tool constructor performs no state/render/ref/port read or action, including startup", () => {
  const deny = new Proxy(
    {},
    {
      get() {
        throw Error("construction read");
      },
    },
  );
  const options = Object.fromEntries(
    [
      "dictation",
      "media",
      "native",
      "render",
      "drafts",
      "currentContext",
      "exchange",
      "focus",
    ].map((key) => [key, deny]),
  ) as unknown as ExchangeInputToolOptions;
  options.openSavedCapture = options.reportInputError = () => {
    throw Error("construction action");
  };
  options.closeSpeech = createExchangeInputToolCloseCommand({
    dictation: deny,
    media: deny,
    currentContext: deny,
    keepExchangeOpen: options.openSavedCapture as () => void,
    focusMicrophone: options.reportInputError as () => void,
  } as unknown as ExchangeInputToolCloseOptions);
  const commands = createExchangeInputToolCommands(options);
  assert.equal(commands.closeSpeech, options.closeSpeech);
  assert.equal(Object.keys(commands).length, 12);
  const startup = pair();
  for (const item of startup)
    item.commands({ project: undefined }).closeSpeech();
  parity(startup);
  assert.deepEqual(
    startup[1].events.map((event) => event[0]),
    ["interrupt", "state:speech"],
  );
});

test("early close remains usable before startup return without initializing the later context title", () => {
  const events: unknown[][] = [];
  let titleInitializations = 0,
    speech: Media["speech"] = scene(empty);
  const dictationControls = {
    current: { toggle() {}, interrupt: () => events.push(["interrupt"]) },
  };
  const currentContext = { current: "A:object" };
  const setSpeech: Media["setSpeech"] = (next) => {
    speech = typeof next === "function" ? next(speech) : next;
    events.push(["state", speech]);
  };
  const deny = new Proxy(
    {},
    {
      get() {
        throw Error("late startup group read");
      },
    },
  );
  function render(ready: boolean) {
    const closeSpeech = createExchangeInputToolCloseCommand({
      dictation: { dictationControls },
      media: { speech, setSpeech },
      currentContext,
      keepExchangeOpen: () => {
        events.push(["keep-open"]);
      },
      focusMicrophone: () => {
        events.push(["microphone-focus"]);
      },
    });
    if (!ready) return { keyboard: closeSpeech };
    const contextTitle = (++titleInitializations, "Original scene");
    const owner = createExchangeInputToolCommands({
      closeSpeech,
      dictation: deny,
      media: deny,
      native: deny,
      render: new Proxy(
        { contextTitle },
        {
          get() {
            throw Error("constructor reads late scene");
          },
        },
      ),
      currentContext: deny,
      drafts: deny,
      exchange: deny,
      focus: deny,
      openSavedCapture() {
        throw Error("construction action");
      },
      reportInputError() {
        throw Error("construction action");
      },
    } as unknown as ExchangeInputToolOptions);
    return { keyboard: closeSpeech, dialog: owner.closeSpeech };
  }
  const startup = render(false);
  assert.equal(titleInitializations, 0);
  assert.deepEqual(events, []);
  startup.keyboard();
  assert.deepEqual(events, [
    ["interrupt"],
    ["keep-open"],
    ["microphone-focus"],
    ["state", null],
  ]);
  const ready = render(true);
  assert.equal(titleInitializations, 1);
  assert.equal(
    ready.keyboard,
    ready.dialog,
    "later Dialog must borrow the exact early keyboard function",
  );
});

test("capture and microphone entries preserve all revision branches and shallow draft references", () => {
  for (const revision of [null, 6])
    for (const artifactRevision of [undefined, 8])
      for (const hasArtifact of [false, true]) {
        const values = pair(
          {},
          { ...empty, body: "original", revision, attachments: [attachment] },
        );
        for (const item of values) {
          const original = item.drafts()["A:object"]!;
          const commands = item.commands({
            artifact: hasArtifact ? { id: "object", revision: 9 } : undefined,
            preferences: { artifactRevision },
          });
          commands.openCapture(true);
          commands.toggleDictation();
          assert.notStrictEqual(item.state.speech!.draft, original);
          assert.strictEqual(
            item.state.speech!.draft.attachments,
            original.attachments,
          );
        }
        parity(values);
      }
});

test("same inline speech toggles latest handle; stale or modal scene creates captured entry", () => {
  for (const speech of [
    scene(empty),
    scene(empty, true),
    { ...scene(empty), key: "B:object" },
  ]) {
    const values = pair({ speech });
    for (const item of values) {
      const commands = item.commands();
      item.dictationControls.current = {
        interrupt: () => item.events.push(["new-interrupt"]),
        toggle: () => item.events.push(["new-toggle"]),
      };
      commands.toggleDictation();
    }
    parity(values);
    if (!speech.modal && speech.key === "A:object")
      assert.deepEqual(values[1].events, [["new-toggle"]]);
  }
});

test("late attachment busy/error/results retain captured key, latest originals, and false map entries", () => {
  const values = pair();
  for (const item of values) {
    const commands = item.commands();
    commands.attachmentsBusyChanged(true);
    item.currentContext.current = "B:object";
    item.updateStored("A:object", {
      ...empty,
      body: "latest original",
      model: "new-model",
      reasoningEffort: "max",
      attachments: [attachment],
    });
    commands.attachmentsChanged((old) => [
      ...old,
      { ...attachment, assetId: "late" },
    ]);
    commands.attachmentError("real upload failure");
    commands.directoryError("real directory failure");
    commands.attachmentsBusyChanged(false);
    assert.equal(item.drafts()["A:object"]!.body, "latest original");
    assert.equal(item.drafts()["B:object"]!.body, "other scene");
    assert.deepEqual(item.state.uploadingDrafts, { "A:object": false });
  }
  parity(values);
});

test("directory completion preserves another scope, but retains original same-scope ABA behavior", () => {
  const values = pair();
  for (const item of values) {
    const old = item.commands();
    old.directorySelectingChanged(true);
    const other = item.commands({ directoryScope: "project-B:B" });
    other.directorySelectingChanged(true);
    old.directorySelectingChanged(false);
    assert.equal(item.state.directoryPickerScope, "project-B:B");
    old.directorySelectingChanged(true);
    old.directorySelectingChanged(false);
    assert.equal(item.state.directoryPickerScope, null);
  }
  parity(values);
});

test("live transcript uses latest original body while modal insert keeps its initial snapshot and focus order", () => {
  const initial = {
    ...empty,
    body: "initial",
    model: "initial-model",
    attachments: [attachment],
  };
  for (const modal of [false, true]) {
    const values = pair({ speech: scene(initial, modal) });
    for (const item of values) {
      const commands = item.commands();
      item.updateStored("A:object", {
        ...initial,
        body: "edited\npartial",
        model: "latest-model",
      });
      commands.transcriptChanged("final", "partial");
      assert.equal(item.drafts()["A:object"]!.body, "edited\nfinal");
      item.currentContext.current = "B:object";
      commands.transcriptInserted("confirmed");
      assert.equal(item.drafts()["A:object"]!.body, "initial\nconfirmed");
      assert.equal(item.drafts()["A:object"]!.model, "initial-model");
      item.input.current = {
        focus: () => item.events.push(["input-focus", "new"]),
      } as unknown as HTMLTextAreaElement;
      item.flushFrames();
      assert.deepEqual(
        item.events.slice(-4).map((event) => event[0]),
        ["state:speech", "interaction", "frame", "input-focus"],
      );
    }
    parity(values);
  }
});

test("modal insertion honors exact 30000 bound and original synchronous failure prefix", () => {
  for (const length of [29999, 30000, 30001]) {
    const values = pair({ speech: scene(empty, true) });
    for (const item of values) {
      const action = () =>
        item.commands().transcriptInserted("x".repeat(length));
      if (length > 30000) {
        assert.throws(action, {
          message:
            "这段文字超过单条消息长度，请先保存为文档，再围绕文档输入；文字不会被截断。",
        });
        assert.deepEqual(item.events, []);
        assert.notEqual(item.state.speech, null);
      } else action();
    }
    parity(values);
  }
});

test("close speech preserves current/stale/modal/null branches, latest controls and synchronous focus-before-null", () => {
  for (const speech of [
    null,
    scene(empty),
    scene(empty, true),
    { ...scene(empty), key: "B:object" },
  ]) {
    const values = pair({ speech, speechRecording: true });
    for (const item of values) item.commands().closeSpeech();
    parity(values);
    assert.equal(
      values[1].state.speechRecording,
      true,
      "recording is retired by original feature cleanup, not this command",
    );
    assert.deepEqual(
      values[1].events.map((event) => event[0]),
      speech && !speech.modal && speech.key === "A:object"
        ? [
            "interrupt",
            "keep-open",
            "query",
            "microphone-focus",
            "state:speech",
          ]
        : ["interrupt", "state:speech"],
    );
  }
});

test("capture result appends latest original; only attach guards showInput, saved navigation remains captured", async () => {
  for (const current of ["A:object", "B:object"])
    for (const action of ["attach", "save", "close"] as const) {
      const values = pair({ capture: capture() });
      for (const item of values) {
        const commands = item.commands();
        item.currentContext.current = current;
        item.updateStored("A:object", {
          ...empty,
          body: "latest original",
          attachments: [attachment],
        });
        if (action === "attach")
          commands.captureAttached({ ...attachment, assetId: "captured" });
        else if (action === "save") commands.captureSaved("saved-object");
        else commands.closeCapture();
        assert.equal(item.state.capture, null);
        if (action === "attach")
          assert.equal(item.drafts()["A:object"]!.attachments!.length, 2);
        if (action === "save")
          assert.deepEqual(item.events.slice(-2), [
            ["state:capture", null],
            ["open-object", "project-A", "saved-object"],
          ]);
      }
      parity(values);
      await Promise.resolve();
      parity(values);
    }
});

test("legal throwing ports preserve original partial action prefix without new catch/finally cleanup", () => {
  for (const [action, failures] of [
    [
      "closeSpeech",
      ["interrupt", "keep-open", "microphone-focus", "state:speech"],
    ],
    [
      "transcriptInserted",
      ["draft-replace", "state:speech", "interaction", "frame"],
    ],
    ["captureAttached", ["draft-update", "state:capture", "show-input"]],
    ["captureSaved", ["state:capture", "open-object"]],
  ] as const)
    for (const failure of failures) {
      const values = pair({ speech: scene(empty), capture: capture() });
      for (const item of values) {
        item.failAt(failure);
        const commands = item.commands();
        assert.throws(
          () => {
            if (action === "transcriptInserted")
              commands.transcriptInserted("confirmed");
            else if (action === "captureAttached")
              commands.captureAttached(attachment);
            else if (action === "captureSaved") commands.captureSaved("saved");
            else commands.closeSpeech();
          },
          { message: "port failed: " + failure },
        );
      }
      parity(values);
    }
});
