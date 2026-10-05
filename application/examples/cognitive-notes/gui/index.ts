import {
  CognitiveBrowserError,
  connectMorphz,
  type BrowserCommandFacts,
  type BrowserCommandResult,
  type BrowserContext,
  type CognitiveBrowserClient,
} from "@morphz/cognitive-app-sdk/browser";
import {
  isPortableText,
  validateOperationValue,
  type OperationResourceReference,
  type JsonValue,
} from "@morphz/cognitive-app-sdk";

const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing fixed author control.");
  return value as T;
};
const button = (id: string) => element<HTMLButtonElement>(id);
const title = element<HTMLInputElement>("title");
const markdown = element<HTMLTextAreaElement>("markdown");
const command = element<HTMLInputElement>("command");
const editor = element<HTMLFormElement>("editor");
const discard = element<HTMLDialogElement>("discard");
let client: CognitiveBrowserClient | undefined;
let selected: OperationResourceReference | undefined;
let loaded: OperationResourceReference | undefined;
let nextAfter: string | undefined;
let dirty = false;
let busy = false;
let uncertain: string | undefined;
let discardAction: (() => void) | undefined;

function status(text: string) {
  element("status").textContent = text;
}
function jsonRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function currentContext(): BrowserContext | undefined {
  try {
    return client?.context;
  } catch {
    client = undefined;
    element("connection").textContent = "工作区连接已结束，请重新打开";
    return undefined;
  }
}
function controls() {
  const context = currentContext();
  const available = !!context?.view.active && !busy;
  for (const id of ["refresh", "new"])
    button(id).disabled = !available || !!uncertain;
  button("next").disabled = !available || !!uncertain || !nextAfter;
  button("read").disabled = !available || !!uncertain || !selected;
  for (const id of ["edit", "open", "remember"])
    button(id).disabled = !available || !!uncertain || !loaded;
  button("compose").disabled =
    !available || !!uncertain || !loaded || !context?.ui.compose;
  button("save").disabled = !available || !!uncertain || !dirty;
  title.disabled = markdown.disabled = busy || !!uncertain;
  command.readOnly = !!uncertain;
  for (const id of ["status-command", "recover"])
    button(id).disabled =
      !available || !/^[A-Za-z0-9_-]{1,100}$/.test(command.value);
}
async function run(action: () => Promise<void>) {
  if (busy || !currentContext()?.view.active) {
    controls();
    return;
  }
  busy = true;
  controls();
  try {
    await action();
  } catch (error) {
    const code =
      error instanceof CognitiveBrowserError ? error.code : "contract";
    status(
      uncertain
        ? "尚未确认保存结果。原命令 ID 和当前编辑已保留，请查询状态或恢复回执。"
        : code === "disposed" || code === "unsupported"
          ? "当前工作区连接已结束。请从工作区重新打开，当前编辑不会自动发送。"
          : "这次操作未获确认，当前原文和编辑已保留。请检查连接与权限后再操作。",
    );
  } finally {
    busy = false;
    controls();
  }
}
function replaceDraft(action: () => void) {
  if (uncertain || busy) return;
  if (!dirty) return action();
  discardAction = action;
  discard.showModal();
  button("keep").focus();
}
button("keep").onclick = () => {
  discardAction = undefined;
  discard.close();
};
button("discard-confirm").onclick = () => {
  const action = discardAction;
  discardAction = undefined;
  discard.close();
  action?.();
};
discard.oncancel = () => {
  discardAction = undefined;
};
function showOriginal(
  reference: OperationResourceReference,
  name: string,
  body: string,
) {
  // A committed summary also has kind/title. Only the two exact opaque
  // locator fields may enter Browser resource requests or navigation state.
  loaded = { objectId: reference.objectId, versionRef: reference.versionRef };
  selected = { objectId: reference.objectId, versionRef: reference.versionRef };
  title.value = name;
  markdown.value = body;
  dirty = false;
  editor.hidden = true;
  element("reader").hidden = false;
  element("heading").textContent = name;
  element("version").textContent = `精确版本：${reference.versionRef}`;
  // Author content is text, never executable HTML or innerHTML.
  element("original").textContent = body;
  controls();
}
async function list(more: boolean) {
  const operation = client!.context.definition.operations.find(
    (item) => item.id === "notes.list",
  )!;
  const response = await client!.invoke({
    operationId: "notes.list",
    parameters: {
      limit: 32,
      ...(more && nextAfter ? { afterObjectId: nextAfter } : {}),
    },
    resources: [],
    commandId: null,
  });
  if (!("protocol" in response))
    throw new Error("Expected author read result.");
  const value = validateOperationValue(
    operation.outputSchema,
    response.result,
  ) as {
    objects: { objectId: string; versionRef: string; title: string }[];
    nextAfterObjectId?: string;
  };
  const list = element("list");
  if (!more) list.replaceChildren();
  for (const note of value.objects) {
    const li = document.createElement("li");
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = note.title;
    item.setAttribute("aria-pressed", "false");
    item.onclick = () => {
      if (busy || uncertain) return;
      selected = { objectId: note.objectId, versionRef: note.versionRef };
      for (const sibling of list.querySelectorAll("button"))
        sibling.setAttribute("aria-pressed", "false");
      item.setAttribute("aria-pressed", "true");
      controls();
    };
    li.append(item);
    list.append(li);
  }
  nextAfter = value.nextAfterObjectId;
  button("next").hidden = !nextAfter;
  element("list-hint").textContent = list.childElementCount
    ? "选择笔记，再读取精确原文。"
    : "当前项目还没有笔记，可以新建一份。";
  status("笔记列表已读取；原文和编辑未改变。");
}
button("refresh").onclick = () => {
  void run(() => list(false));
};
button("next").onclick = () => {
  void run(() => list(true));
};
button("read").onclick = () =>
  replaceDraft(() => {
    const reference = selected && { ...selected };
    if (!reference) return;
    void run(async () => {
      const result = await client!.readObject({
        object: reference,
        maxBytes: 128_000,
      });
      if (result.content.format !== "json")
        throw new Error("Expected notes JSON original.");
      const body = result.content.value;
      if (
        !jsonRecord(body) ||
        typeof body.title !== "string" ||
        typeof body.markdown !== "string"
      )
        throw new Error("Invalid original.");
      showOriginal(result.object, body.title, body.markdown);
      status("已读取所选精确版本。");
    });
  });
button("new").onclick = () =>
  replaceDraft(() => {
    loaded = undefined;
    title.value = markdown.value = "";
    dirty = false;
    editor.hidden = false;
    element("reader").hidden = true;
    status("新笔记尚未保存。");
    controls();
    title.focus();
  });
button("edit").onclick = () => {
  editor.hidden = false;
  element("reader").hidden = true;
  title.focus();
};
for (const field of [title, markdown])
  field.oninput = () => {
    dirty = true;
    controls();
  };
function commandFacts(facts: BrowserCommandFacts) {
  const labels = {
    admitted: "已接收，尚未确认提交",
    dispatching: "已交给作者，尚未确认提交",
    unknown: "结果尚未确认",
    committed: "作者已确认保存",
    rejected: "作者已明确拒绝",
    cancelled: "命令已取消",
  } as const;
  status(`${labels[facts.state]}。原命令 ID：${facts.commandId}`);
  if (facts.state === "rejected" || facts.state === "cancelled")
    uncertain = undefined;
}
function acceptWrite(result: BrowserCommandResult) {
  commandFacts(result.command);
  if (result.command.state !== "committed") return;
  uncertain = undefined;
  const reference =
    result.command.objects?.length === 1
      ? result.command.objects[0]
      : undefined;
  const body = result.result;
  if (
    reference &&
    jsonRecord(body) &&
    body.objectId === reference.objectId &&
    body.versionRef === reference.versionRef &&
    typeof body.title === "string" &&
    typeof body.markdown === "string"
  ) {
    showOriginal(reference, body.title, body.markdown);
    status("作者已确认保存；列表不会自动刷新。可打开原文或引用协作。");
  } else {
    status(
      "作者已确认保存，但回执没有完整原文。当前编辑仍在；请刷新列表并显式读取精确版本后再编辑。",
    );
    // A confirmed write with incomplete projection must not invite a second
    // create from the same draft. Explicit New/Read can still discard it.
    dirty = false;
  }
}
// The fixed sandbox intentionally has no allow-forms permission. Saving is
// an explicit local button action, never a form navigation or permission lift.
editor.onsubmit = (event) => {
  event.preventDefault();
};
button("save").onclick = () => {
  if (!dirty || uncertain || busy || !currentContext()?.view.active) {
    controls();
    return;
  }
  if (!title.value.trim() || !isPortableText(title.value)) {
    status("请填写可移植的非空标题。");
    return;
  }
  const reference = loaded && { ...loaded };
  const parameters: JsonValue = {
    ...(reference
      ? {
          objectId: reference.objectId,
          baselineVersionRef: reference.versionRef,
        }
      : {}),
    title: title.value,
    markdown: markdown.value,
  };
  const commandId = crypto.randomUUID();
  uncertain = commandId;
  command.value = commandId;
  element<HTMLDetailsElement>("recovery").open = true;
  void run(async () => {
    const result = await client!.invoke({
      operationId: reference ? "notes.revise" : "notes.create",
      parameters,
      resources: reference ? [reference] : [],
      commandId,
    });
    if (!("kind" in result)) throw new Error("Expected fixed command result.");
    acceptWrite(result);
  });
};
command.oninput = controls;
button("status-command").onclick = () => {
  void run(async () =>
    commandFacts(await client!.commandStatus(command.value)),
  );
};
button("recover").onclick = () => {
  void run(async () => {
    const result = await client!.recoverReceipt(command.value);
    // Manual recovery of another command does not replace a current editor.
    if (uncertain === result.commandId) acceptWrite(result);
    else commandFacts(result.command);
  });
};
button("open").onclick = () =>
  replaceDraft(() => {
    const object = loaded && { ...loaded };
    if (object)
      void run(async () => {
        await client!.openObject({ object });
        status("工作区已确认打开这份精确原文。");
      });
  });
button("compose").onclick = () =>
  replaceDraft(() => {
    const object = loaded && { ...loaded };
    if (object)
      void run(async () => {
        await client!.compose({ text: "请基于这份原文整理要点。", object });
        status(
          "原文引用已准备到输入框，尚未发送。引用只携带精确原件与版本，不复制正文。",
        );
      });
  });
button("remember").onclick = () => {
  const object = loaded && { ...loaded };
  if (object)
    void run(async () => {
      await client!.saveState({
        expectedRevision: client!.context.view.revision,
        state: { object, view: "reading" },
      });
      status("已记住阅读位置；正文、草稿和命令 ID 没有写入宿主状态。");
    });
};
void connectMorphz()
  .then((connected) => {
    client = connected;
    const context = () => {
      const current = connected.context;
      document.documentElement.dataset.appearance = current.theme.appearance;
      document.documentElement.dataset.accent = current.theme.accent;
      element("connection").textContent = current.view.active
        ? "工作区已连接"
        : "工作区当前不可操作";
      // Reopening remembers only a locator. Neither list nor original is read.
      if (!selected && current.view.state.object)
        selected = { ...current.view.state.object };
      controls();
    };
    connected.onContextChange(context);
    context();
  })
  .catch(() => {
    element("connection").textContent = "请从支持此界面的 Morphz 工作区打开";
    status("未连接工作区；没有读取、创建或发送任何笔记。");
  });
