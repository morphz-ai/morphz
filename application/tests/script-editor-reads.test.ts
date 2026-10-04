import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isFunctionDeclaration,
  isPropertyAssignment,
  isArrowFunction,
  isPrefixUnaryExpression,
  isPostfixUnaryExpression,
  isBinaryExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { createScriptEditorReads } from "../apps/web/src/data/script-editor-reads.js";
import {
  createFixedScriptEditorReads,
  type FixedScriptEditorBindings,
} from "./fixtures/script-editor-reads-4ce98b64.js";
import type { ScriptEditorProduction } from "../apps/web/src/script-editor-reader.js";
import type {
  PlatformClient,
  PlatformContent,
} from "../apps/web/src/platform-client.js";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
} from "../packages/core/src/script-studio.js";

const fixedHashes: Record<string, string> = {
  readScriptEditorPage:
    "6b6243e383a1dbf5f966811f487e7add53f3dc92d464a10da35f8a8c0e2fc98c",
  readScriptEditor:
    "0b77bafc8178f0e2da068467ce47cedd6a1f1f72157017ce9ca7e7eaa7a92fa7",
  getScriptEditor:
    "db10891c09c3ba81f53412dc0334d6dc65b3c263c250bf4ac47345ccd825b46d",
  readScriptVersion:
    "98edc6a88a29308e50f9f4b5b824bd4dabfbcb5671b9695368d1150e95dcfcdd",
  readScriptCandidate:
    "3c96afafe1864dd0e993e222b23d9c5a8e344e05864fcd8e6042da92e0340e81",
  readScriptVersionTitle:
    "c8e6e6d8227f95b47c611caef114988bbb2ffb4d82945b5c8155d153ab816f03",
  readScriptReview:
    "893d8135fcc80af00189244763a952537652956ee95883d6fe005409f755025c",
  readScriptExport:
    "538df04a9cfdddded6cb9331e09d52dec1508282c5354e3bf0397217dfc3fb78",
  readScriptContext:
    "ad4757708498286998db3383021e7d067526a686229f972a7f8d1f41d30610b1",
  readScriptExportManifest:
    "5e30de789e81e048cf7b0c53da5b04a85d5d731249b9bb133484f3979a3c5108",
  resolveScriptLocation:
    "46c7ecba6238f1b6f5760fa9ab597fe56dd841f72c11ebbac7cba60e1f6482bc",
  scriptVersionTitle:
    "16740eb88b9b487d07f7659050e0a61ca4591d8268b83fe392ea2b2602b7e397",
};
function shape(node: Node, source: SourceFile): unknown {
  const children: unknown[] = [];
  node.forEachChild((child) => {
    children.push(shape(child, source));
  });
  return [
    node.kind,
    ...(isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? [node.operator]
      : []),
    ...(isBinaryExpression(node) ? [node.operatorToken.kind] : []),
    children.length ? children : node.getText(source),
  ];
}
function fixtureHashes(text: string) {
  const directory = "/script-editor-fixed",
    config = directory + "/tsconfig.json";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [directory + "/fixture.ts"]: text,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["fixture.ts"],
      }),
    }),
  });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(directory + "/fixture.ts")!;
    const hashes: Record<string, string> = {};
    function visit(node: Node) {
      let target: Node | undefined, name: string | undefined;
      if (
        isFunctionDeclaration(node) &&
        node.name &&
        node.name.text in fixedHashes
      ) {
        name = node.name.text;
        target = node;
      } else if (
        isPropertyAssignment(node) &&
        node.name.getText(source) === "scriptVersionTitle" &&
        isArrowFunction(node.initializer)
      ) {
        name = "scriptVersionTitle";
        target = node.initializer;
      }
      if (target && name)
        hashes[name] = createHash("sha256")
          .update(JSON.stringify(shape(target, source)))
          .digest("hex");
      node.forEachChild((child) => {
        visit(child);
      });
    }
    visit(source);
    return hashes;
  } finally {
    snapshot.dispose();
    api.close();
  }
}
test("固定 4ce98b64 的十二个旧算法，CI 不读 Git 或新 owner 算法", () => {
  const text = readFileSync(
    new URL("./fixtures/script-editor-reads-4ce98b64.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(fixtureHashes(text), fixedHashes);
  assert.notDeepEqual(
    fixtureHashes(
      text.replace(
        "if (cached !== undefined) return cached;",
        'if (cached !== undefined) return "";',
      ),
    ),
    fixedHashes,
  );
  assert.notDeepEqual(
    fixtureHashes(
      text.replace(
        "if (target.itemId && !item) return null;",
        "if (target.itemId || !item) return null;",
      ),
    ),
    fixedHashes,
  );
});

const now = "2026-10-04T00:00:00.000Z",
  author = { principalId: "human", actantId: "human-actant" };
function header(id = "script-one") {
  return {
    id,
    projectId: "project-one",
    title: "剧本原件",
    revision: 1,
    brief: { ...emptyScriptBrief },
    reviewerPrincipalIds: ["human"],
    template: { ...defaultScriptExportTemplate },
    createdBy: author,
    createdAt: now,
    updatedAt: now,
    activityRevision: 5,
    creativeEpoch: 1,
    totals: {
      items: 1,
      candidates: 0,
      pendingCandidates: 0,
      reviews: 0,
      pendingReviews: 0,
      exports: 0,
      metadataVersions: 1,
    },
  };
}
const item = {
  id: "scene-one",
  kind: "scene" as const,
  revision: 2,
  workflowRevision: 3,
  status: "draft" as const,
  title: "当前场景",
  parentId: null,
  order: 0,
  basis: "original" as const,
  dependencies: [],
  characters: [],
  approval: null,
  textCharacters: 0,
  sourceCount: 0,
  pendingCandidateCount: 0,
  currentPendingReviewCount: 0,
  blockingReviewCount: 0,
  hasText: false,
  approvalCurrent: false,
};
function catalog(id = "script-one"): PlatformContent {
  return {
    id: "content-" + id,
    appId: "morphz.script-studio",
    instanceId: "studio-instance",
    providerRevision: 2,
    appObjectId: id,
    projectId: "project-one",
    kind: "script",
    title: "剧本原件",
    observedVersionRef: "5",
    availability: "available",
    revision: 7,
    createdAt: now,
    updatedAt: now,
  };
}
function model(id = "script-one"): ScriptEditorProduction {
  return {
    ...header(id),
    contentId: catalog(id).id,
    catalogRevision: 7,
    providerRevision: 2,
    items: [item],
  };
}
function rawVersion(itemId = "scene-one", revision = 2) {
  return {
    productionId: "script-one",
    itemId,
    kind: "scene",
    status: "draft",
    headRevision: 2,
    workflowRevision: 3,
    revision,
    candidateId: null,
    author,
    createdAt: now,
    approvalForRequestedVersion: null,
    draft: emptyScriptDraft("场景 v" + revision),
  };
}
function candidate(id = "candidate-one") {
  return {
    id,
    inputId: "input-one",
    targetId: "scene-one",
    baseRevision: 2,
    contextRevision: 1,
    references: [],
    draft: emptyScriptDraft("候选原文"),
    explanation: "",
    createdBy: author,
    createdAt: now,
    revision: 1,
    ordinal: 1,
    stale: false,
    acceptedRevision: null,
    status: "pending",
    decisionBy: null,
    decidedAt: null,
  };
}
function review(id = "review-one") {
  return {
    id,
    itemId: "scene-one",
    itemRevision: 2,
    quote: "",
    body: "审阅原件",
    severity: "note",
    author,
    createdAt: now,
    inputId: null,
    contextRevision: 1,
    revision: 1,
    resolvedBy: null,
    resolvedAt: null,
    resolution: "",
  };
}
const metadata = {
  revision: 1,
  title: "剧本原件",
  brief: { ...emptyScriptBrief },
  reviewerPrincipalIds: ["human"],
  template: { ...defaultScriptExportTemplate },
  author,
  createdAt: now,
};
const exported = {
  id: "export-one",
  createdBy: author,
  createdAt: now,
  contextRevision: 1,
  items: [{ itemId: "scene-one", revision: 2 }],
  template: { ...defaultScriptExportTemplate },
  format: "docx",
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Mode = "fixed" | "production";
function fixture(mode: Mode) {
  const trace: unknown[][] = [];
  const models: FixedScriptEditorBindings["scriptEditorModels"] = {
    current: new Map(),
  };
  const titles = { current: new Map<string, string>() };
  const current: FixedScriptEditorBindings["current"] = {
    current: { csrfToken: "csrf-A", scriptLibrary: [model() as never] },
  };
  let generation = 0;
  let afterRemember = () => {};
  let readItem = async (
    contentId: string,
    itemId: string,
    revision?: number,
  ): Promise<unknown> => {
    trace.push(["item", contentId, itemId, revision]);
    return rawVersion(itemId, revision ?? 2);
  };
  let resolveContent = async (request: {
    appId: string;
    appObjectId: string;
  }): Promise<PlatformContent> => {
    trace.push(["resolve", request]);
    return request.appId === "morphz.script-studio"
      ? catalog(request.appObjectId)
      : {
          ...catalog(),
          id: "source-content",
          appId: request.appId,
          appObjectId: request.appObjectId,
          instanceId: "source-instance",
        };
  };
  let getContent = async (id: string): Promise<PlatformContent> => {
    trace.push(["get", id]);
    return catalog(id.replace("content-", ""));
  };
  const source = {
    resolveContent: (request: { appId: string; appObjectId: string }) =>
      resolveContent(request),
    getContent: (id: string) => getContent(id),
    readScriptItem: (contentId: string, itemId: string, revision?: number) =>
      readItem(contentId, itemId, revision),
  } as unknown as PlatformClient;
  let rpc = async (
    method: string,
    raw: unknown,
    options: unknown,
  ): Promise<unknown> => {
    trace.push(["call", method, raw, options]);
    const request = raw as Record<string, unknown>;
    const id = String(request.contentId ?? "").replace("content-", "");
    if (method === "scripts.editor.head") return header(id);
    if (method === "scripts.editor.page")
      return {
        productionId: id,
        activityRevision: 5,
        total: 1,
        nextCursor: null,
        items: [item],
      };
    switch (request.kind) {
      case "item-version-title":
        return {
          productionId: id,
          itemId: request.objectId,
          revision: request.revision,
          title: "精确标题 " + request.revision,
        };
      case "candidate":
        return candidate(String(request.objectId));
      case "review":
        return review(String(request.objectId));
      case "export":
        return exported;
      case "context":
        return metadata;
    }
    throw new Error("unexpected isolated request");
  };
  const session = () => {
    trace.push(["session"]);
    const identity = current.current,
      capturedGeneration = generation;
    if (!identity) throw new Error("身份已变化，剧本未读取。");
    return {
      identity,
      source,
      check() {
        trace.push(["check"]);
        if (
          current.current?.csrfToken !== identity.csrfToken ||
          generation !== capturedGeneration
        )
          throw new Error("身份或访问范围已变化，剧本未读取。");
      },
    };
  };
  const call: FixedScriptEditorBindings["applicationCall"] = (...args) =>
    rpc(...(args as [string, unknown, unknown]));
  const rememberContent = (entry: PlatformContent, identity: string) => {
    trace.push(["remember", entry.id, identity]);
    afterRemember();
  };
  const api =
    mode === "fixed"
      ? createFixedScriptEditorReads({
          scriptEditorModels: models,
          scriptVersionTitles: titles,
          current,
          scriptReadSession: session,
          applicationCall: call,
          rememberContent,
        })
      : createScriptEditorReads({
          models,
          titles,
          session,
          call,
          rememberContent,
          currentIdentity: () => current.current?.csrfToken,
          currentEntry: (id) =>
            current.current?.scriptLibrary.find((entry) => entry.id === id),
        });
  return {
    api,
    trace,
    models,
    titles,
    current,
    source,
    revoke: () => {
      generation++;
    },
    onRemember: (fn: () => void) => {
      afterRemember = fn;
    },
    setRpc: (fn: typeof rpc) => {
      rpc = fn;
    },
    setReadItem: (fn: typeof readItem) => {
      readItem = fn;
    },
    setResolve: (fn: typeof resolveContent) => {
      resolveContent = fn;
    },
    setGet: (fn: typeof getContent) => {
      getContent = fn;
    },
  };
}
async function compare(
  run: (f: ReturnType<typeof fixture>) => Promise<unknown>,
) {
  const results = [];
  for (const mode of ["fixed", "production"] as const) {
    const f = fixture(mode),
      result = await run(f);
    results.push({
      result,
      trace: f.trace,
      models: [...f.models.current.keys()],
      titles: [...f.titles.current],
    });
  }
  assert.deepEqual(results[1], results[0]);
  return results[1]!;
}

test("owner 构造 inert，端口零读取、没有副本缓存", () => {
  const forbidden = () => {
    throw new Error("constructor read a port");
  };
  const api = createScriptEditorReads({
    models: {
      get current() {
        return forbidden();
      },
    },
    titles: {
      get current() {
        return forbidden();
      },
    },
    session: forbidden,
    call: forbidden,
    currentIdentity: forbidden,
    currentEntry: forbidden,
    rememberContent: forbidden,
  });
  assert.equal(typeof api.readScriptEditor, "function");
  assert.equal(typeof api.clear, "function");
});
test("目录完整读取与缓存命中逐 await 校验不增加目录 collect 后 check", async () => {
  const result = await compare(async (f) => {
    const value = await f.api.readScriptEditor("script-one");
    assert.equal(f.api.getScriptEditor("script-one"), value);
    const firstTrace = [...f.trace];
    const second = await f.api.readScriptEditor("script-one");
    assert.equal(second, value);
    assert.deepEqual(
      firstTrace.map((row) => row[0]),
      [
        "session",
        "resolve",
        "check",
        "call",
        "check",
        "call",
        "check",
        "get",
        "check",
        "remember",
      ],
    );
    return value;
  });
  assert.equal(result.trace.filter((row) => row[0] === "get").length, 1);
});
test("独立 page 每页 check 后另作最终 check，全部分页与错误仍由 reader 拥有", async () => {
  await compare(async (f) => {
    f.setRpc(async (method, request, options) => {
      f.trace.push(["call", method, request, options]);
      const raw = request as { after?: string };
      return {
        productionId: "script-one",
        activityRevision: 5,
        itemId: "scene-one",
        total: 2,
        nextCursor: raw.after ? null : "next",
        versions: [
          {
            revision: raw.after ? 1 : 2,
            author,
            createdAt: now,
            candidateId: null,
            title: "旧标题",
            textCharacters: 0,
          },
        ],
      };
    });
    const value = await f.api.readScriptEditorPage(
      model(),
      "versions",
      "scene-one",
    );
    assert.deepEqual(
      f.trace.map((row) => row[0]),
      ["session", "call", "check", "call", "check", "check"],
    );
    return value;
  });
});
test("getEditor 同步使用最新目录/身份，只核原 catalog 与 activity（不新增 provider/session 条件）", async () => {
  await compare(async (f) => {
    const value = await f.api.readScriptEditor("script-one");
    f.current.current!.scriptLibrary[0] = {
      ...model(),
      providerRevision: 99,
    } as never;
    assert.equal(f.api.getScriptEditor("script-one"), value);
    f.current.current!.scriptLibrary[0] = {
      ...model(),
      activityRevision: 6,
    } as never;
    assert.equal(f.api.getScriptEditor("script-one"), undefined);
    f.current.current!.scriptLibrary[0] = model() as never;
    f.current.current = { ...f.current.current!, csrfToken: "csrf-B" };
    assert.equal(f.api.getScriptEditor("script-one"), undefined);
    f.current.current = null;
    assert.equal(f.api.getScriptEditor("script-one"), undefined);
    return "same";
  });
});
test("版本和候选先解析真实来源再 check；同 csrf 的 revoke/regrant 代次变化拒绝迟到正文", async () => {
  for (const candidateRead of [false, true])
    await compare(async (f) => {
      const held = deferred<PlatformContent>(),
        entered = deferred<void>();
      f.setResolve(async (request) => {
        f.trace.push(["source", request]);
        entered.resolve();
        return held.promise;
      });
      const draft = {
        ...emptyScriptDraft("精确正文"),
        sources: [
          {
            appId: "morphz.objects",
            instanceId: "source-instance",
            objectId: "source-object",
            versionRef: "7",
            quote: "原选文",
          },
        ],
      };
      if (candidateRead)
        f.setRpc(async (method, request, options) => {
          f.trace.push(["call", method, request, options]);
          return { ...candidate(), draft };
        });
      else
        f.setReadItem(async () => {
          f.trace.push(["item"]);
          return { ...rawVersion(), draft };
        });
      const pending = candidateRead
        ? f.api.readScriptCandidate(model(), "candidate-one")
        : f.api.readScriptVersion(model(), "scene-one", 2);
      const rejected = assert.rejects(pending, /身份或访问范围已变化/);
      await entered.promise;
      f.revoke();
      f.api.clear();
      f.current.current = { ...f.current.current! };
      held.resolve({
        ...catalog(),
        id: "source-content",
        instanceId: "source-instance",
      });
      await rejected;
      assert.equal(f.titles.current.size, 0);
      assert.deepEqual(
        f.trace.map((row) => row[0]),
        ["session", candidateRead ? "call" : "item", "source", "check"],
      );
      return "rejected";
    });
});
test("已保存版本标题与独立标题共享精确缓存；命中仍返回 async Promise，getter 仍同步", async () => {
  await compare(async (f) => {
    const value = await f.api.readScriptVersion(model(), "scene-one", 2);
    assert.equal(
      f.api.scriptVersionTitle("script-one", "scene-one", 2),
      value.draft.title,
    );
    const order: string[] = [];
    const pending = f.api.readScriptVersionTitle(model(), "scene-one", 2);
    assert.ok(pending instanceof Promise);
    void pending.then(() => {
      order.push("title");
    });
    order.push("caller");
    await Promise.resolve();
    assert.deepEqual(order, ["caller", "title"]);
    assert.equal(await pending, value.draft.title);
    assert.equal(
      await f.api.readScriptVersionTitle(model(), "scene-one", 1),
      "精确标题 1",
    );
    f.current.current = { ...f.current.current!, csrfToken: "csrf-B" };
    assert.equal(
      f.api.scriptVersionTitle("script-one", "scene-one", 2),
      undefined,
    );
    return order;
  });
});
test("模型 64 条为 FIFO；命中不刷新插入顺序，替换原 key 不成为 LRU", async () => {
  await compare(async (f) => {
    const first = await f.api.readScriptEditor("script-0");
    for (let at = 1; at < 64; at++)
      await f.api.readScriptEditor("script-" + at);
    assert.equal(await f.api.readScriptEditor("script-0"), first);
    first.activityRevision = 4;
    const replacement = await f.api.readScriptEditor("script-0");
    assert.notEqual(replacement, first);
    await f.api.readScriptEditor("script-64");
    assert.equal(f.models.current.size, 64);
    assert.equal(f.models.current.has("script-0"), false);
    assert.equal(f.models.current.keys().next().value, "script-1");
    return [...f.models.current.keys()];
  });
});
test("标题 512 条为 FIFO；readVersion 更新旧 key 与 title cache hit 不刷新次序", async () => {
  await compare(async (f) => {
    for (let revision = 1; revision <= 512; revision++)
      await f.api.readScriptVersionTitle(model(), "scene-one", revision);
    await f.api.readScriptVersion(model(), "scene-one", 1);
    assert.equal(
      await f.api.readScriptVersionTitle(model(), "scene-one", 1),
      "场景 v1",
    );
    await f.api.readScriptVersionTitle(model(), "scene-one", 513);
    assert.equal(f.titles.current.size, 512);
    assert.equal(
      f.api.scriptVersionTitle("script-one", "scene-one", 1),
      undefined,
    );
    assert.equal(
      f.titles.current.keys().next().value,
      "csrf-A:script-one:scene-one:2",
    );
    return f.titles.current.size;
  });
});
test("review/export/context 保留 schema→check→精确对象身份错误；失败不写缓存", async () => {
  await compare(async (f) => {
    const result = [
      await f.api.readScriptReview(model(), "review-one"),
      await f.api.readScriptExport(model(), "export-one"),
      await f.api.readScriptContext(model(), 1),
    ];
    f.setRpc(async (_method, request) => {
      switch ((request as { kind: string }).kind) {
        case "review":
          return review("wrong-review");
        case "export":
          return { ...exported, id: "wrong-export" };
        case "context":
          return { ...metadata, revision: 2 };
      }
      return null;
    });
    await assert.rejects(
      f.api.readScriptReview(model(), "review-one"),
      /审阅意见身份不一致/,
    );
    await assert.rejects(
      f.api.readScriptExport(model(), "export-one"),
      /导出记录身份不一致/,
    );
    await assert.rejects(
      f.api.readScriptContext(model(), 1),
      /剧本规范版本不一致/,
    );
    return result;
  });
});
test("清理同步清两原 Map；进行中 Promise 未被主动取消，原 session check 决定交付", async () => {
  await compare(async (f) => {
    const held = deferred<unknown>();
    f.setRpc(async () => {
      return held.promise;
    });
    const pending = f.api.readScriptVersionTitle(model(), "scene-one", 2);
    f.models.current.set("script-one", { identity: "csrf-A", value: model() });
    f.titles.current.set("csrf-A:script-one:scene-one:1", "旧标题");
    f.api.clear();
    assert.equal(f.models.current.size + f.titles.current.size, 0);
    held.resolve({
      productionId: "script-one",
      itemId: "scene-one",
      revision: 2,
      title: "已清后完成",
    });
    assert.equal(await pending, "已清后完成");
    assert.equal(
      f.api.scriptVersionTitle("script-one", "scene-one", 2),
      "已清后完成",
    );
    return "original behavior";
  });
});
test("manifest 子读分别 capture session、顺序读取及去重，外层 check 在各版本后与末尾", async () => {
  await compare(async (f) => {
    f.setReadItem(async (contentId, itemId, revision) => {
      f.trace.push(["item", contentId, itemId, revision]);
      return {
        ...rawVersion(itemId, revision),
        draft: {
          ...emptyScriptDraft(itemId),
          dependencies:
            itemId === "scene-one"
              ? [{ itemId: "scene-two", revision: 1 }]
              : [],
        },
      };
    });
    const value = await f.api.readScriptExportManifest(model(), "export-one");
    assert.deepEqual(
      value.versions.map((version) => version.id),
      ["scene-one", "scene-two"],
    );
    assert.equal(f.trace.filter((row) => row[0] === "session").length, 5);
    assert.deepEqual(
      f.trace.map((row) => row[0]),
      [
        "session",
        "session",
        "call",
        "check",
        "session",
        "call",
        "check",
        "session",
        "item",
        "check",
        "check",
        "session",
        "item",
        "check",
        "check",
        "check",
      ],
    );
    return value;
  });
});
test("resolveLocation 各 sibling 独立 session，精确版本与候选/审阅不匹配早 null", async () => {
  await compare(async (f) => {
    const target = {
      productionId: "script-one",
      itemId: "scene-one",
      revision: 2,
      candidateId: "candidate-one",
      reviewId: "review-one",
    };
    const result = await f.api.resolveScriptLocation(target);
    assert.equal(result?.item?.id, "scene-one");
    assert.equal(f.trace.filter((row) => row[0] === "session").length, 5);
    f.setRpc(async (method, request, options) => {
      f.trace.push(["call", method, request, options]);
      if (method === "scripts.editor.head") return header();
      return { ...candidate(), baseRevision: 1 };
    });
    assert.equal(
      await f.api.resolveScriptLocation({ ...target, reviewId: undefined }),
      null,
    );
    return result;
  });
});
test("resolve 缺少 item 在外层末尾 check 之前早 null；不新增 late guard", async () => {
  await compare(async (f) => {
    f.onRemember(f.revoke);
    assert.equal(
      await f.api.resolveScriptLocation({
        productionId: "script-one",
        itemId: "missing-item",
      }),
      null,
    );
    assert.equal(f.trace.at(-1)?.[0], "remember");
    return "early null";
  });
});
test("RPC 原失败与目录确认变化不被吞掉/重试，任何失败保留原缓存", async () => {
  await compare(async (f) => {
    const marker = new Error("original transport error");
    f.setRpc(async () => {
      throw marker;
    });
    await assert.rejects(
      f.api.readScriptEditor("script-one"),
      (error) => error === marker,
    );
    assert.equal(f.models.current.size, 0);
    return f.trace.map((row) => row[0]);
  });
  await compare(async (f) => {
    f.setGet(async (id) => {
      f.trace.push(["get", id]);
      return { ...catalog(), providerRevision: 3 };
    });
    await assert.rejects(
      f.api.readScriptEditor("script-one"),
      /剧本目录已变化/,
    );
    assert.equal(f.models.current.size, 0);
    return f.trace.map((row) => row[0]);
  });
});
