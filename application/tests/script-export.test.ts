import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { buildScriptDocx } from "../packages/core/src/script-studio-docx.js";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
  scriptProductionSchema,
} from "../packages/core/src/script-studio.js";

const require = createRequire(import.meta.url);
const fs: typeof import("node:fs") = require("node:fs");
const {
  createScriptExportSaver,
} = require("../apps/desktop/script-export.cjs");
const request = {
  centerId: "center",
  principalId: "human",
  productionId: "production",
  exportId: "export",
};
const content = new Uint8Array([0x50, 0x4b, 3, 4, 12, 34, 56]);
const event = { source: "trusted-main" };
function setup(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), "morphz-script-save-unit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = join(directory, "TEST-script.docx");
  const state = {
    focused: true,
    destroyed: false,
    trusted: true,
    reads: 0,
    dialogs: 0,
    boot: {
      centerId: "center",
      principalId: "human",
      csrfToken: "synthetic-test-identity-marker",
      workspace: {
        projects: [{ id: "project" }],
        scriptProductions: [
          {
            id: "production",
            projectId: "project",
            title: "TEST 剧本",
            exports: [{ id: "export" }],
          },
        ],
      },
    },
  };
  const window = {
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
  };
  let currentWindow = window;
  let select: () => Promise<{
    canceled: boolean;
    filePath?: string;
  }> = async () => ({ canceled: false, filePath: destination });
  let build: (production: unknown, exportId: string) => Uint8Array = () =>
    content;
  let onRead: (count: number) => void = () => {};
  const saver = createScriptExportSaver({
    requireMain(value: unknown) {
      if (value !== event || !state.trusted)
        throw new Error("untrusted source");
    },
    getWindow: () => currentWindow,
    connection: {
      async call(method: string) {
        assert.equal(method, "workspace");
        onRead(++state.reads);
        return structuredClone(state.boot);
      },
    },
    dialog: {
      async showSaveDialog(
        parent: unknown,
        options: { filters: unknown; defaultPath: string },
      ) {
        assert.equal(parent, window);
        state.dialogs++;
        assert.deepEqual(options.filters, [
          { name: "Word 文档", extensions: ["docx"] },
        ]);
        assert.equal(options.defaultPath.includes("/"), false);
        return select();
      },
    },
    buildDocx: (production: unknown, exportId: string) =>
      build(production, exportId),
  });
  return {
    directory,
    destination,
    state,
    saver,
    select(fn: typeof select) {
      select = fn;
    },
    build(fn: typeof build) {
      build = fn;
    },
    onRead(fn: typeof onRead) {
      onRead = fn;
    },
    changeWindow() {
      currentWindow = { ...window };
    },
    files() {
      return fs.readdirSync(directory);
    },
  };
}

test("native save writes exact bytes, returns digest (no path), and safely repeats a confirmed save", async (t) => {
  const f = setup(t);
  const receipt = await f.saver.save(event, request);
  assert.deepEqual(receipt, {
    status: "saved",
    exportId: "export",
    filename: "TEST-script.docx",
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  assert.deepEqual(fs.readFileSync(f.destination), Buffer.from(content));
  fs.writeFileSync(f.destination, "old confirmed target");
  assert.deepEqual(await f.saver.save(event, request), receipt);
  assert.deepEqual(fs.readFileSync(f.destination), Buffer.from(content));
  assert.deepEqual(f.files(), ["TEST-script.docx"]);
  assert.equal(f.state.reads, 6);
});

test("native save reconstructs genuine OOXML from a frozen domain receipt", async (t) => {
  const f = setup(t);
  const author = { principalId: "human", actantId: "human" };
  const createdAt = "2026-09-18T00:00:00.000Z";
  const template = { ...defaultScriptExportTemplate };
  const production = scriptProductionSchema.parse({
    id: "production",
    projectId: "project",
    title: "TEST 冻结导出",
    revision: 1,
    brief: { ...emptyScriptBrief },
    reviewerPrincipalIds: ["human"],
    createdBy: author,
    createdAt,
    updatedAt: createdAt,
    items: [
      {
        id: "episode",
        kind: "episode",
        revision: 1,
        workflowRevision: 4,
        status: "locked",
        versions: [
          {
            revision: 1,
            draft: {
              ...emptyScriptDraft("第一集"),
              text: "TEST 合成正文：雨夜回家。",
            },
            author,
            createdAt,
            candidateId: null,
          },
        ],
        approval: {
          revision: 1,
          contextRevision: 1,
          author,
          createdAt,
          note: "TEST",
        },
        events: [],
      },
    ],
    candidates: [],
    reviews: [],
    template,
    metadataHistory: [
      {
        revision: 1,
        title: "TEST 冻结导出",
        brief: { ...emptyScriptBrief },
        reviewerPrincipalIds: ["human"],
        template,
        author,
        createdAt,
      },
    ],
    exports: [
      {
        id: "export",
        createdBy: author,
        createdAt,
        contextRevision: 1,
        items: [{ itemId: "episode", revision: 1 }],
        template,
        format: "docx",
      },
    ],
  });
  f.state.boot.workspace.scriptProductions = [production];
  f.build((value, id) => buildScriptDocx(value as typeof production, id));
  await f.saver.save(event, request);
  assert.deepEqual(
    fs.readFileSync(f.destination),
    Buffer.from(buildScriptDocx(production, "export")),
  );
});

test("cancel never writes, clears the pending slot, and cannot report saved", async (t) => {
  const f = setup(t);
  f.select(async () => ({ canceled: true }));
  assert.deepEqual(await f.saver.save(event, request), {
    status: "cancelled",
    exportId: "export",
  });
  assert.deepEqual(f.files(), []);
  f.select(async () => ({ canceled: false, filePath: f.destination }));
  assert.equal((await f.saver.save(event, request)).status, "saved");
});

test("untrusted, unfocused, arbitrary-path/content and malformed IPC requests cannot open a dialog", async (t) => {
  const f = setup(t);
  await assert.rejects(f.saver.save({}, request), /untrusted/);
  f.state.focused = false;
  await assert.rejects(f.saver.save(event, request), /窗口/);
  f.state.focused = true;
  for (const bad of [
    null,
    [],
    {},
    { ...request, filePath: f.destination },
    { ...request, bytes: [1] },
    { ...request, exportId: "../other" },
    { ...request, exportId: "" },
  ]) {
    await assert.rejects(f.saver.save(event, bad), /导出请求无效/);
  }
  assert.equal(f.state.dialogs, 0);
  assert.deepEqual(f.files(), []);
});

test("missing identity, project access, production or receipt fails before any save dialog", async (t) => {
  for (const change of [
    (f: ReturnType<typeof setup>) => {
      f.state.boot.centerId = "other";
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.principalId = "other";
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.workspace.projects = [];
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.workspace.scriptProductions = [];
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.workspace.scriptProductions[0]!.exports = [];
    },
  ]) {
    const f = setup(t);
    change(f);
    await assert.rejects(f.saver.save(event, request), /身份|无权/);
    assert.equal(f.state.dialogs, 0);
    assert.deepEqual(f.files(), []);
  }
});

test("dialog rechecks identity, auth generation marker, access, receipt and originating window", async (t) => {
  const changes = [
    (f: ReturnType<typeof setup>) => {
      f.state.boot.centerId = "other";
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.principalId = "other";
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.csrfToken = "changed-test-marker";
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.workspace.projects = [];
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.workspace.scriptProductions = [];
    },
    (f: ReturnType<typeof setup>) => {
      f.state.boot.workspace.scriptProductions[0]!.exports = [];
    },
    (f: ReturnType<typeof setup>) => {
      f.state.trusted = false;
    },
    (f: ReturnType<typeof setup>) => {
      f.saver.invalidate();
    },
    (f: ReturnType<typeof setup>) => {
      f.changeWindow();
    },
    (f: ReturnType<typeof setup>) => {
      f.state.destroyed = true;
    },
    (f: ReturnType<typeof setup>) => {
      f.build(() => new Uint8Array([...content, 99]));
    },
  ];
  for (const change of changes) {
    const f = setup(t);
    f.select(async () => {
      change(f);
      return { canceled: false, filePath: f.destination };
    });
    await assert.rejects(f.saver.save(event, request));
    assert.deepEqual(f.files(), []);
  }
});

test("second permission check prevents publishing a temporary file after revoked access", async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.destination, "untouched existing file");
  f.onRead((count) => {
    if (count === 3) f.state.boot.workspace.projects = [];
  });
  await assert.rejects(f.saver.save(event, request), /无权/);
  assert.equal(
    fs.readFileSync(f.destination, "utf8"),
    "untouched existing file",
  );
  assert.deepEqual(f.files(), ["TEST-script.docx"]);
});

test("one pending dialog; concurrent calls rejected and invalidation settles without writing", async (t) => {
  const f = setup(t);
  let release!: (value: { canceled: boolean; filePath: string }) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.select(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.saver.save(event, request);
  await waiting;
  await assert.rejects(f.saver.save(event, request), /正在进行/);
  f.saver.invalidate();
  release({ canceled: false, filePath: f.destination });
  await assert.rejects(pending, /窗口/);
  assert.equal(f.state.dialogs, 1);
  assert.deepEqual(f.files(), []);
});

test("invalid destinations and symlinks are rejected without changing their targets", async (t) => {
  const f = setup(t);
  const original = join(f.directory, "original.txt");
  fs.writeFileSync(original, "preserve");
  fs.symlinkSync(original, f.destination);
  const folder = join(f.directory, "directory.docx");
  fs.mkdirSync(folder);
  for (const path of [
    "relative.docx",
    join(f.directory, "bad.exe"),
    folder,
    f.destination,
    join(f.directory, "missing", "out.docx"),
  ]) {
    f.select(async () => ({ canceled: false, filePath: path }));
    await assert.rejects(f.saver.save(event, request));
    assert.equal(fs.readFileSync(original, "utf8"), "preserve");
    assert.equal(
      f.files().some((name) => name.startsWith(".morphz-script-")),
      false,
    );
  }
});

test("a changed destination is not overwritten and staging file is removed", async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.destination, "confirmed contents");
  f.onRead((count) => {
    if (count === 3) fs.writeFileSync(f.destination, "concurrent replacement");
  });
  await assert.rejects(f.saver.save(event, request), /保存位置已变化/);
  assert.equal(
    fs.readFileSync(f.destination, "utf8"),
    "concurrent replacement",
  );
  assert.deepEqual(f.files(), ["TEST-script.docx"]);
});

test("build, partial-write and atomic-publish failures never yield a saved receipt", async (t) => {
  const f = setup(t);
  f.build(() => {
    throw new Error("invalid frozen receipt");
  });
  await assert.rejects(f.saver.save(event, request), /invalid frozen/);
  assert.equal(f.state.dialogs, 0);
  f.build(() => content);
  const write = fs.writeFileSync;
  const writeMock = t.mock.method(fs, "writeFileSync", ((
    ...args: Parameters<typeof fs.writeFileSync>
  ) => {
    if (typeof args[0] === "number") {
      write(args[0], new Uint8Array([1]));
      throw new Error("disk full");
    }
    return write(...args);
  }) as typeof fs.writeFileSync);
  await assert.rejects(f.saver.save(event, request), /disk full/);
  writeMock.mock.restore();
  assert.deepEqual(f.files(), []);
  const linkMock = t.mock.method(fs, "linkSync", () => {
    throw new Error("publish denied");
  });
  await assert.rejects(f.saver.save(event, request), /publish denied/);
  linkMock.mock.restore();
  assert.deepEqual(f.files(), []);
  fs.writeFileSync(f.destination, "original");
  const renameMock = t.mock.method(fs, "renameSync", () => {
    throw new Error("rename denied");
  });
  await assert.rejects(f.saver.save(event, request), /rename denied/);
  renameMock.mock.restore();
  assert.equal(fs.readFileSync(f.destination, "utf8"), "original");
  assert.deepEqual(f.files(), ["TEST-script.docx"]);
  assert.equal((await f.saver.save(event, request)).status, "saved");
});

test("published file remains saved with a cleanup warning when staging unlink fails", async (t) => {
  const f = setup(t);
  const unlinkMock = t.mock.method(fs, "unlinkSync", () => {
    throw new Error("staging unlink denied");
  });
  let receipt;
  try {
    receipt = await f.saver.save(event, request);
  } finally {
    unlinkMock.mock.restore();
  }
  assert.deepEqual(receipt, {
    status: "saved",
    exportId: "export",
    filename: "TEST-script.docx",
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    warning: "temporary-file-cleanup-failed",
  });
  assert.deepEqual(fs.readFileSync(f.destination), Buffer.from(content));
  const staging = f
    .files()
    .filter((name) => name.startsWith(".morphz-script-"));
  assert.equal(staging.length, 1);
  const stagingFile = staging[0];
  assert.ok(
    stagingFile,
    "published save must retain the failed-cleanup staging file",
  );
  assert.deepEqual(
    fs.readFileSync(join(f.directory, stagingFile)),
    Buffer.from(content),
  );
  assert.equal(fs.statSync(join(f.directory, stagingFile)).mode & 0o777, 0o600);
  // The warning neither leaks a local path nor wedges the concurrency guard.
  assert.equal(JSON.stringify(receipt).includes(f.directory), false);
  fs.rmSync(join(f.directory, stagingFile));
  const repeated = await f.saver.save(event, request);
  assert.equal(repeated.status, "saved");
  assert.equal(repeated.warning, undefined);
  assert.deepEqual(f.files(), ["TEST-script.docx"]);
});

test("pre-publication cleanup failure is explicit, preserves existing targets and releases pending", async (t) => {
  for (const existing of [false, true]) {
    const f = setup(t);
    if (existing) fs.writeFileSync(f.destination, "preserve confirmed file");
    const publishMock = t.mock.method(
      fs,
      existing ? "renameSync" : "linkSync",
      () => {
        throw new Error("publish denied");
      },
    );
    const cleanupMock = t.mock.method(fs, "rmSync", () => {
      throw new Error("cleanup denied");
    });
    try {
      await assert.rejects(
        f.saver.save(event, request),
        /本次未发布文件.*临时文件清理失败/,
      );
    } finally {
      publishMock.mock.restore();
      cleanupMock.mock.restore();
    }
    assert.equal(fs.existsSync(f.destination), existing);
    if (existing)
      assert.equal(
        fs.readFileSync(f.destination, "utf8"),
        "preserve confirmed file",
      );
    const staging = f
      .files()
      .filter((name) => name.startsWith(".morphz-script-"));
    assert.equal(staging.length, 1);
    const stagingFile = staging[0];
    assert.ok(
      stagingFile,
      "pre-publication cleanup failure must leave the staging file",
    );
    fs.rmSync(join(f.directory, stagingFile));
    assert.equal((await f.saver.save(event, request)).status, "saved");
    assert.deepEqual(f.files(), ["TEST-script.docx"]);
  }
});

test("malformed or oversized generated bytes fail closed before showing the destination picker", async (t) => {
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array(32 * 1024 * 1024 + 1),
  ]) {
    const f = setup(t);
    f.build(() => bytes);
    await assert.rejects(f.saver.save(event, request), /无效或超出/);
    assert.equal(f.state.dialogs, 0);
    assert.deepEqual(f.files(), []);
  }
});
