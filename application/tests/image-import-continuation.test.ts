import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { isFunctionDeclaration, type Node } from "typescript/unstable/ast";
import { transformWithOxc } from "vite";

// Run the actual finite importImage function with controlled upload/command/UI
// ports. These tests do not mount App, authorize a server write, upload bytes,
// start a Browser/HTTP Host/Runtime, or prove Electron file-picker behavior.
const baselineFunctionSHA =
  "6541d95c3c50d90eb34186386d32fab375079f67dd6eb067c14bc1a165d8d2d7";
const regressedFunctionSHA =
  "c223f15b649be914c97686862a1c2639de4e4bd3f0ef89457385f1a9f46224d5";
const sha = (source: string) =>
  createHash("sha256").update(source).digest("hex");

function extractImportImage(source: string) {
  const directory = "/image-import-source",
    config = directory + "/tsconfig.json",
    file = directory + "/App.tsx";
  const api = new API({
    cwd: directory,
    fs: createVirtualFileSystem({
      [file]: source,
      [config]: JSON.stringify({
        compilerOptions: { jsx: "preserve", noLib: true, noResolve: true },
        files: ["App.tsx"],
      }),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)!.program;
      assert.deepEqual(program.getSyntacticDiagnostics(), []);
      const sourceFile = program.getSourceFile(file)!;
      const functions: string[] = [];
      function visit(node: Node) {
        if (isFunctionDeclaration(node) && node.name?.text === "importImage")
          functions.push(node.getText(sourceFile));
        node.forEachChild(visit);
      }
      visit(sourceFile);
      assert.equal(functions.length, 1, "one actual importImage declaration");
      return functions[0]!;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
// Copied from actual Git 0eaf6e0a App source, independently checked against its
// original full-source SHA 9106cd243b4c7eb160719865dbd40cd9028506f81f03e060dda7065cb6dd811f.
// The embedded oracle and its frozen function SHA also work in shallow clones.
const originalFunction = String.raw`async function importImage(image: File | undefined) {
    if (!image || !project || importing) return;
    setImporting(true);
    try {
      const { assetId } = await client.upload(image);
      const receipt = await client.execute({
        type: "create-artifact",
        projectId: project.id,
        title: image.name.replace(/\.[^.]+$/, "").slice(0, 180) || "导入的图片",
        content: { kind: "image", assetId, alt: "" },
      });
      await openObject(project.id, receipt.entityId);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "导入失败。");
    } finally {
      setImporting(false);
      if (file.current) file.current.value = "";
    }
  }`;
const productionFunction = extractImportImage(
  readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8"),
);

// Exact function retained from the reviewed uncommitted App SHA 75f98ec6e759...
// before its upload-time navigation guard was repaired. Keeping this separate
// from the candidate preserves the confirmed behavioral counterexample.
const regressedFunction = String.raw`async function importImage(image: File | undefined) {
    if (!origin.isActive()) return;
    const expectedNavigation = navigationGeneration.current;
    if (!image || !project || importing) return;
    setImporting(true);
    try {
      const { assetId } = await client.upload(image);
      if (!origin.isActive() || !navigation.isCurrent(expectedNavigation))
        return;
      const receipt = await client.execute({
        type: "create-artifact",
        projectId: project.id,
        title: image.name.replace(/\.[^.]+$/, "").slice(0, 180) || "导入的图片",
        content: { kind: "image", assetId, alt: "" },
      });
      if (!origin.isActive() || !navigation.isCurrent(expectedNavigation))
        return;
      await openObject(project.id, receipt.entityId);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "导入失败。");
    } finally {
      setImporting(false);
      if (file.current) file.current.value = "";
    }
  }`;

type PickedImage = { name: string };
type CreateImage = {
  type: "create-artifact";
  projectId: string;
  title: string;
  content: { kind: "image"; assetId: string; alt: string };
};
type Event =
  | { kind: "busy"; value: boolean }
  | { kind: "upload"; name: string }
  | { kind: "execute"; operation: CreateImage }
  | { kind: "open"; projectId: string; id: string }
  | { kind: "notice"; message: string }
  | { kind: "clear"; value: string };
type ImportAction = (image: PickedImage | undefined) => Promise<void>;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
async function fixture(
  source = productionFunction,
  options: { active?: boolean; project?: boolean; importing?: boolean } = {},
) {
  const result = await transformWithOxc(
    source + "\nexport { importImage };",
    "image-import.ts",
  );
  const code = result.code.replace(/export\s*\{[^}]*\};?\s*$/, "");
  assert.notEqual(code, result.code, "remove only the transform's export");
  const events: Event[] = [];
  const upload = deferred<{ assetId: string }>();
  const execute = deferred<{ entityId: string }>();
  const open = deferred<void>();
  const navigationGeneration = { current: 4 };
  let active = options.active ?? true,
    selectedProjectId = "original-project",
    value = "original-input-selection";
  const originalInput = {
    get value() {
      return value;
    },
    set value(next: string) {
      value = next;
      events.push({ kind: "clear", value: next });
    },
  };
  const file: { current: typeof originalInput | null } = {
    current: originalInput,
  };
  const ports = {
    Error,
    origin: { isActive: () => active },
    navigationGeneration,
    navigation: {
      isCurrent: (generation: number) =>
        generation === navigationGeneration.current,
    },
    project: options.project === false ? null : { id: "original-project" },
    importing: options.importing ?? false,
    setImporting: (next: boolean) => events.push({ kind: "busy", value: next }),
    client: {
      upload(image: PickedImage) {
        events.push({ kind: "upload", name: image.name });
        return upload.promise;
      },
      execute(operation: CreateImage) {
        // Convert the VM object to the host realm without changing its fields.
        events.push({
          kind: "execute",
          operation: JSON.parse(JSON.stringify(operation)) as CreateImage,
        });
        return execute.promise;
      },
    },
    openObject(projectId: string, id: string) {
      events.push({ kind: "open", projectId, id });
      return open.promise;
    },
    setNotice(message: string) {
      // Actual App's notice adapter rejects writes after private retirement.
      if (active) events.push({ kind: "notice", message });
    },
    file,
  };
  const action = runInNewContext(
    code + "\nimportImage;",
    ports,
  ) as ImportAction;
  return {
    action,
    events,
    upload,
    execute,
    open,
    file,
    selectedProjectId: () => selectedProjectId,
    inputValue: () => value,
    navigate(id = "later-project") {
      selectedProjectId = id;
      navigationGeneration.current++;
    },
    retire() {
      active = false;
      file.current = null;
    },
  };
}
const operation = (title = "chosen-image"): CreateImage => ({
  type: "create-artifact",
  projectId: "original-project",
  title,
  content: { kind: "image", assetId: "uploaded-original", alt: "" },
});
async function complete(
  scene: Awaited<ReturnType<typeof fixture>>,
  pending: Promise<void>,
) {
  scene.upload.resolve({ assetId: "uploaded-original" });
  await turn();
  scene.execute.resolve({ entityId: "created-image" });
  await turn();
  scene.open.resolve();
  await pending;
}

test("fixed Git 0eaf6e0a original and the confirmed pre-repair regression retain independently frozen function SHA", () => {
  assert.equal(sha(originalFunction), baselineFunctionSHA);
  assert.equal(sha(regressedFunction), regressedFunctionSHA);
});
test("normal import keeps original upload/create/open order, exact captured parameters, await and final cleanup", async () => {
  const original = await fixture(originalFunction);
  const candidate = await fixture();
  for (const scene of [original, candidate]) {
    const pending = scene.action({ name: "chosen-image.png" });
    assert.deepEqual(scene.events, [
      { kind: "busy", value: true },
      { kind: "upload", name: "chosen-image.png" },
    ]);
    scene.upload.resolve({ assetId: "uploaded-original" });
    await turn();
    assert.deepEqual(scene.events.at(-1), {
      kind: "execute",
      operation: operation(),
    });
    scene.execute.resolve({ entityId: "created-image" });
    await turn();
    assert.deepEqual(scene.events.at(-1), {
      kind: "open",
      projectId: "original-project",
      id: "created-image",
    });
    assert.equal(scene.inputValue(), "original-input-selection");
    scene.open.resolve();
    await pending;
    assert.deepEqual(scene.events.slice(-2), [
      { kind: "busy", value: false },
      { kind: "clear", value: "" },
    ]);
  }
  assert.deepEqual(candidate.events, original.events);
});
test("merely navigating during upload keeps the approved original-project creation and rejects its late open", async () => {
  for (const source of [originalFunction, productionFunction]) {
    const scene = await fixture(source);
    const pending = scene.action({ name: "chosen-image.png" });
    scene.navigate();
    await complete(scene, pending);
    assert.equal(scene.selectedProjectId(), "later-project");
    assert.deepEqual(
      scene.events.filter((event) => event.kind === "execute"),
      [{ kind: "execute", operation: operation() }],
    );
    assert.equal(
      scene.events.filter((event) => event.kind === "open").length,
      source === originalFunction ? 1 : 0,
    );
    assert.deepEqual(scene.events.slice(-2), [
      { kind: "busy", value: false },
      { kind: "clear", value: "" },
    ]);
  }
});
test("the independently retained regression reproduces cancellation of creation after navigation during upload", async () => {
  const scene = await fixture(regressedFunction);
  const pending = scene.action({ name: "chosen-image.png" });
  scene.navigate();
  await complete(scene, pending);
  assert.deepEqual(scene.events, [
    { kind: "busy", value: true },
    { kind: "upload", name: "chosen-image.png" },
    { kind: "busy", value: false },
    { kind: "clear", value: "" },
  ]);
  assert.throws(
    () =>
      assert.deepEqual(
        scene.events.filter((event) => event.kind === "execute"),
        [{ kind: "execute", operation: operation() }],
      ),
    assert.AssertionError,
  );
});
test("origin retirement during upload prevents a new create and retains finally without touching another private input", async () => {
  const scene = await fixture();
  const pending = scene.action({ name: "chosen-image.png" });
  scene.retire();
  await complete(scene, pending);
  assert.deepEqual(scene.events, [
    { kind: "busy", value: true },
    { kind: "upload", name: "chosen-image.png" },
    { kind: "busy", value: false },
  ]);
  assert.equal(scene.inputValue(), "original-input-selection");
});
test("navigation or origin retirement while create is pending preserves that original command and suppresses its late open", async () => {
  for (const transition of ["navigate", "retire"] as const) {
    const scene = await fixture();
    const pending = scene.action({ name: "chosen-image.png" });
    scene.upload.resolve({ assetId: "uploaded-original" });
    await turn();
    assert.deepEqual(scene.events.at(-1), {
      kind: "execute",
      operation: operation(),
    });
    scene[transition]();
    scene.execute.resolve({ entityId: "created-image" });
    await pending;
    assert.equal(
      scene.events.filter((event) => event.kind === "execute").length,
      1,
    );
    assert.equal(
      scene.events.filter((event) => event.kind === "open").length,
      0,
    );
    assert.ok(
      scene.events.some((event) => event.kind === "busy" && !event.value),
    );
    assert.equal(
      scene.inputValue(),
      transition === "navigate" ? "" : "original-input-selection",
    );
  }
});
test("original title derivation retains the extension rule, fallback and 180-character boundary", async () => {
  for (const [name, title] of [
    ["archive.part.jpeg", "archive.part"],
    [".png", "导入的图片"],
    ["no-extension", "no-extension"],
    ["a".repeat(200) + ".png", "a".repeat(180)],
  ]) {
    const original = await fixture(originalFunction);
    const candidate = await fixture();
    for (const scene of [original, candidate]) {
      const pending = scene.action({ name: name! });
      await complete(scene, pending);
      assert.deepEqual(
        scene.events.filter((event) => event.kind === "execute"),
        [{ kind: "execute", operation: operation(title!) }],
      );
    }
    assert.deepEqual(candidate.events, original.events);
  }
});
test("upload, create and open failures keep original notice and cleanup order, including non-Error fallback", async () => {
  for (const phase of ["upload", "execute", "open"] as const) {
    for (const reason of [
      new Error("exact import failure"),
      { failed: true },
    ]) {
      const original = await fixture(originalFunction);
      const candidate = await fixture();
      for (const scene of [original, candidate]) {
        const pending = scene.action({ name: "chosen-image.png" });
        if (phase !== "upload") {
          scene.upload.resolve({ assetId: "uploaded-original" });
          await turn();
        }
        if (phase === "open") {
          scene.execute.resolve({ entityId: "created-image" });
          await turn();
        }
        scene[phase].reject(reason);
        await pending;
        assert.deepEqual(scene.events.slice(-3), [
          {
            kind: "notice",
            message: reason instanceof Error ? reason.message : "导入失败。",
          },
          { kind: "busy", value: false },
          { kind: "clear", value: "" },
        ]);
      }
      assert.deepEqual(candidate.events, original.events);
    }
  }
});
test("missing selection/project and an already busy import keep the original inert entry; retired origin is inert too", async () => {
  for (const options of [{ project: false }, { importing: true }]) {
    for (const source of [originalFunction, productionFunction]) {
      const scene = await fixture(source, options);
      await scene.action({ name: "chosen-image.png" });
      assert.deepEqual(scene.events, []);
    }
  }
  for (const source of [originalFunction, productionFunction]) {
    const scene = await fixture(source);
    await scene.action(undefined);
    assert.deepEqual(scene.events, []);
  }
  const retired = await fixture(productionFunction, { active: false });
  await retired.action({ name: "chosen-image.png" });
  assert.deepEqual(retired.events, []);
});
