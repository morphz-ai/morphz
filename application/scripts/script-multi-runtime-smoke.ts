/** Synthetic mechanism gate, not a creative-quality claim. The actual Rust
 * Runtime, canonical Harness, Unix Host and SQLite stores execute two inputs
 * in one Session. Only this isolated loopback provider is used; no model quota,
 * original profile, or original Runtime is accessed. */
import "./application-configuration.mjs";
import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
// @ts-ignore Runtime binary discovery is a shared JavaScript CLI helper.
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  emptyScriptDraft,
  type ScriptDraft,
} from "../packages/core/src/script-studio.js";
import type { Receipt } from "../packages/core/src/model.js";
// This module's guarded live runner is NOT invoked. These are pure validators.
import {
  assertNoCreativeWrites,
  assertThreeCandidateDeliveries,
  contextContainsProposal,
} from "./script-confirmation-quality.js";

type Message = { role: string; content: string; [key: string]: unknown };
type ModelInput = {
  messages: Message[];
  tools?: { function: { name: string } }[];
  stream?: boolean;
};
type RuntimeEvent = {
  id: string;
  type: string;
  context_id: string;
  session_id: string;
  root_turn_id: string | null;
  payload: string;
};
type Delivery = {
  inputId: string;
  state: string;
  error: string | null;
  rootId: string | null;
  sessionId: string;
  platformSource?: { body?: string; text?: string; scriptGeneration?: unknown };
};
type ReadTarget = {
  id: string;
  kind: string;
  revision: number;
  draft: ScriptDraft;
};
type Preparation = {
  input_id: string;
  target_item_id: string;
  base_item_revision: number;
  task_request: string;
};
type CommandReceipt = {
  operation: string;
  result_object_id: string;
  input_id: string | null;
  result_version_ref: string | null;
};

const harnessFile = fileURLToPath(
  new URL("../harnesses/script-studio.hns", import.meta.url),
);
assert.equal(
  /\(version "([^"]+)"\)/.exec(readFileSync(harnessFile, "utf8"))?.[1],
  "1.4.4",
);
assert.equal(scriptStudioApplication.harness?.version, "1.4.4");
const directory = mkdtempSync(join(tmpdir(), "morphz-script-multi-runtime-"));
const runtimeDirectory = join(directory, "runtime"),
  appDirectory = join(directory, "application");
for (const path of [runtimeDirectory, appDirectory])
  mkdirSync(path, { mode: 0o700 });
const token = randomBytes(32).toString("hex"),
  secrets = [token];
const proposalText =
  "建议先为《领证前夜》完成两位主角设定和五场戏大纲，分别提交到主角一、主角二、五场戏大纲三个现有空条目。每项一个候选，整体一轮自审，合计不超过6000字符；不写完整对白正文，不自动采纳或批准。你确认后我再执行。";
const task =
  "用户明确确认共享Context中的唯一当前提案：为《领证前夜》分别交付两位主角设定和五场戏大纲，保存到主角一、主角二、五场戏大纲三个现有条目；每项一个候选，整体一轮自审，全部输出不超过6000字符，不写完整对白正文，不自动采纳或批准。";
const confirmationBody = "好的，你直接做。";
const requests: {
  sequence: number;
  stage: string;
  origin: string;
  input: ModelInput;
}[] = [];
const logical = new Map<string, string>();
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let runtime: ChildProcessWithoutNullStreams | undefined;
let failure: Error | undefined,
  logs = "",
  discussionCount = 0,
  prepareStep = 0;
let readTargets: ReadTarget[] = [],
  payload: { targetId: string; payload: ScriptDraft; explanation: string }[] =
    [];
const save = (file: string, value: unknown) =>
  writeFileSync(
    join(directory, file),
    secrets.reduce(
      (text, secret) => text.split(secret).join("[redacted]"),
      JSON.stringify(value, null, 2),
    ),
    { mode: 0o600 },
  );
const sql = <T>(
  path: string,
  query: string,
  ...args: (string | number)[]
): T[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(query).all(...args) as T[];
  } finally {
    db.close();
  }
};
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const wait = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Isolated Runtime exited: ${label}`);
    if (await check()) return;
    await pause(120);
  }
  throw new Error(`Timed out: ${label}`);
};
const evidence: Record<string, unknown> = {
  realRustRuntime: true,
  realUnixHost: true,
  realSQLite: true,
  syntheticProvider: true,
  realModel: false,
  originalDataUsed: false,
  originalRuntimeModified: false,
  maximumRequests: 16,
};
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as ModelInput;
    const tools = input.tools?.map((tool) => tool.function.name) ?? [];
    const context = JSON.stringify(input.messages),
      start = context.lastIndexOf("(evaluate ");
    const current = start < 0 ? context : context.slice(start);
    const internal = current.includes("(root-kind chat/infer_request)");
    const stage = internal
      ? [
          ...current.matchAll(
            /STAGE script-(discussion|intent|prepare|create|review|revise|delivery)/g,
          ),
        ].at(-1)?.[1]
      : "relay";
    assert.ok(stage, "Every actual model request must identify its Yao stage");
    const origin = /\(origin-turn ([^)]+)\)/.exec(current)?.[1];
    assert.ok(
      origin,
      "Actual persisted infer/root identity must reach the provider",
    );
    assert.equal(logical.get(origin) ?? stage, stage);
    logical.set(origin, stage);
    requests.push({ sequence: requests.length + 1, stage, origin, input });
    assert.ok(requests.length <= 16, "Bounded synthetic provider allowance");
    save("provider-evidence.json", requests);
    assert.ok(context.includes("morphz.script-studio"));
    assert.ok(context.includes("script-studio/scene-and-screen"));
    assert.ok(
      tools.every(
        (name) =>
          name === "no_reply" ||
          (stage === "relay" && name === "reply") ||
          (stage === "prepare" && name === "host_morphz"),
      ),
      `Forbidden model tool in ${stage}: ${tools.join(",")}`,
    );
    if (internal)
      assert.ok(
        !current.includes("original text has"),
        "Infer input must not be truncated",
      );
    const respond = (message: unknown, finish = "stop") => {
      if (input.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: message, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: randomUUID(),
            choices: [{ index: 0, message, finish_reason: finish }],
          }),
        );
      }
    };
    const value = (content: unknown) =>
      respond({ role: "assistant", content: JSON.stringify(content) });
    const call = (name: string, args: unknown) =>
      respond(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      );
    if (stage === "discussion") {
      assert.ok(
        discussionCount < 2,
        "Only proposal and confirmation produce intent",
      );
      const confirmation = discussionCount++ === 1;
      if (confirmation) {
        assert.ok(
          contextContainsProposal(input.messages, proposalText),
          "The actual previous reply must be present in shared Context",
        );
        assert.ok(current.includes(confirmationBody));
      }
      return value({
        execute: confirmation,
        reply: confirmation ? "" : proposalText,
        task: confirmation ? task : "",
      });
    }
    if (stage === "prepare") {
      assert.ok(
        current.includes(task),
        "Intent.task must explicitly reach prepare captures",
      );
      assert.ok(
        current.includes(confirmationBody),
        "Original short input remains present",
      );
      const step = prepareStep++;
      if (step === 0)
        return call("host_morphz", {
          action: "script",
          script: { action: "list", query: "TEST 领证前夜" },
        });
      const last = input.messages
        .filter((message) => message.role === "tool")
        .at(-1);
      assert.ok(
        last,
        "Only actual Host observations determine IDs and versions",
      );
      const observation = JSON.parse(last.content);
      const result = observation.result
        ? typeof observation.result === "string" &&
          observation.result.startsWith("{")
          ? JSON.parse(observation.result)
          : observation.result
        : observation;
      assert.equal(result.ok, true, JSON.stringify(result));
      if (step === 1) {
        assert.equal(result.items.length, 1);
        return call("host_morphz", {
          action: "script",
          script: {
            action: "read-production",
            productionId: result.items[0].id,
          },
        });
      }
      if (step === 2) {
        readTargets = result.items as ReadTarget[];
        assert.deepEqual(readTargets.map((target) => target.kind).sort(), [
          "character",
          "character",
          "outline",
        ]);
        assert.equal(readTargets.length, 3);
        const targets = readTargets.map((target) => ({
          targetId: target.id,
          baseRevision: target.revision,
          references: [],
        }));
        return call("host_morphz", {
          action: "script",
          script: {
            action: "prepare-workflow",
            productionId: result.productionId,
            ...targets[0],
            contextRevision: result.contextRevision,
            purpose: "draft",
            targets,
            task,
            maxReviewPasses: 1,
            maxOutputCharacters: 6000,
          },
        });
      }
      if (step === 3) {
        assert.equal(result.prepared, true);
        assert.equal(result.generations.length, 3);
        assert.equal(result.task, task);
        return call("host_morphz", {
          action: "script",
          script: { action: "read-workflow" },
        });
      }
      assert.equal(step, 4, "Freeze all targets in a single preparation call");
      assert.equal(result.generating, true);
      assert.equal(result.body, confirmationBody);
      assert.equal(result.task, task);
      assert.equal(result.outputSchema.type, "array");
      assert.deepEqual(
        result.targets.map(
          (entry: { target: { itemId: string } }) => entry.target.itemId,
        ),
        readTargets.map((entry) => entry.id),
      );
      readTargets = result.targets.map(
        (entry: {
          target: {
            itemId: string;
            kind: string;
            revision: number;
            draft: ScriptDraft;
          };
          materials: unknown[];
        }) => {
          assert.ok(
            entry.materials.length >= 1,
            "Every fixed target has independently scoped materials",
          );
          return { ...entry.target, id: entry.target.itemId };
        },
      );
      return value("三项目标已真实固定，Yao继续生成。");
    }
    if (stage === "create") {
      assert.equal(readTargets.length, 3);
      assert.ok(current.includes(task));
      for (const target of readTargets)
        assert.ok(
          current.includes(target.id),
          "Frozen target and materials reach creative inference",
        );
      const characterText = [
        "林澈，二十九岁，城市工程师。她想在领证前确认二人的承诺可以落实为共同承担，而不是用婚礼掩盖双方家庭的实际要求。她习惯把风险列成清单，紧张时反复整理文件，不轻易暴露担忧。她曾独自照顾患病父亲，最怕婚后继续成为默认承担者，却也害怕自己的防备伤害亲密关系。这一晚，她必须选择把不可妥协的底线说出来，同时承认自己的控制欲。",
        "陈望，三十岁，社区医生。他想让领证如期完成，证明两人能够携手，但习惯先答应所有人再独自承担，常把亲密沟通变成安抚。他关心父母，也真正在意伴侣，只是误把承诺等同于立即解决。他担心承认能力有限会令林澈失望，因此回避房子、生育和照护安排的细节。这一晚，他必须停止替她作决定，允许未知存在，用具体分工而非空泛保证争取信任。",
      ];
      let character = 0;
      payload = readTargets.map((target) => ({
        targetId: target.id,
        payload: {
          ...target.draft,
          text:
            target.kind === "outline"
              ? "第一场：婚前夜，林澈整理领证材料，发现陈望已答应让父母搬来同住。原本轻松的清单变成两人尚未讨论的责任清单。\n第二场：陈望解释承诺只是临时照护，林澈追问临时的期限。他尝试用未来买房的保证化解矛盾，却承认首付仍依赖父母。\n第三场：关于房子的争执牵出生育计划。林澈说出照护父亲后的疲惫，陈望第一次意识到她反对的不是自己的父母，而是默认承担。\n第四场：父母来电要求确认领证时间。陈望不再替二人答应，将电话转为共同讨论，提出照护费用、时间与居住边界，接受暂时没有完美方案。\n第五场：两人重写清单，列出可执行分工和仍需商议的事项。林澈把领证材料留在桌上，陈望把未确定的项目圈起。他们选择带着诚实的边界走向明天，而不是假装冲突已经消失。"
              : characterText[character++]!,
          sources: target.draft.sources,
        },
        explanation:
          "合成固定文稿仅验证三个完整交付的实际因果链，不代表真实模型质量验收。",
      }));
      return value({
        blocked: false,
        message: "",
        payload,
        explanation: "两位主角与五场戏大纲分别交付，候选等待人工采纳。",
      });
    }
    if (stage === "review") {
      assert.equal(payload.length, 3);
      for (const entry of payload) assert.ok(current.includes(entry.targetId));
      assert.ok(
        current.includes("第五场"),
        "Whole multi-target product reaches one review",
      );
      return value({
        revise: false,
        blocked: false,
        notes:
          "合成核对：三个独立目标有完整正文，大纲恰为五场；本 gate 不评价真实模型创作质量。",
      });
    }
    if (stage === "delivery") {
      assert.ok(current.includes("单目标 ok=false"));
      assert.ok(
        current.includes(
          "多目标以逐项 results 为准，不根据批次 ok 推断各项是否保存",
        ),
      );
      assert.ok(current.includes("savedCount"));
      for (const target of readTargets) assert.ok(current.includes(target.id));
      return value(
        "两位主角设定与五场戏大纲已分别保存为三个候选，整体完成一轮自审，均待人工采纳，未批准或锁稿。",
      );
    }
    assert.equal(
      stage,
      "relay",
      "No unexpected intent, revision or second workflow",
    );
    assert.ok(
      tools.includes("reply"),
      "Outer terminal response must use the actual v2 reply carrier",
    );
    const content =
      discussionCount === 1
        ? proposalText
        : "两位主角设定与五场戏大纲已分别保存为三个候选，整体完成一轮自审，均待人工采纳，未批准或锁稿。";
    return call("reply", {
      content,
      annotations: {
        execution: { title: "验证简短确认与三个独立交付", result: content },
      },
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    response.writeHead(500);
    response.end("Synthetic mechanism gate rejected request");
  }
});

console.log(
  JSON.stringify({
    evidenceDirectory: directory,
    syntheticProvider: true,
    maximumRequests: 16,
  }),
);
try {
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerPort = (provider.address() as { port: number }).port;
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  writeFileSync(
    join(appDirectory, "runtime.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      token,
      namespace: randomUUID(),
    }),
    { mode: 0o600 },
  );
  const configFile = join(runtimeDirectory, "morphz.toml");
  writeFileSync(
    configFile,
    `[llm]\nmodel="test-model"\nreasoning_effort="low"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[models.test-model]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="MORPHZ_APP_TEST_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
    { mode: 0o600 },
  );
  process.env.MORPHZ_APP_ENV_FILE = "";
  host = await openEmbeddedApplication(
    appDirectory,
    join(directory, "profile"),
  );
  assert.ok(host.manifestPath);
  const manifest = JSON.parse(readFileSync(host.manifestPath, "utf8"));
  assert.ok(manifest.tools[0]?.ipc_path);
  assert.ok(
    !manifest.tools[0]?.endpoint,
    "Real embedded Host must use Unix IPC",
  );
  secrets.push(...manifest.tools.map((tool: { token: string }) => tool.token));
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    MORPHZ_HOME: runtimeDirectory,
    MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
    MORPHZ_DASHBOARD_TOKEN: token,
    MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
    MORPHZ_EVAL_CALLABLE_TOOLS: "host_morphz",
    MORPHZ_APP_TEST_KEY: "isolated-synthetic-key",
  };
  const binary = runtimeBinaryPath();
  assert.ok(existsSync(binary));
  const installed = spawnSync(
    binary,
    [
      "harness",
      "install",
      harnessFile,
      "--cwd",
      runtimeDirectory,
      "--config-file",
      configFile,
      "--format",
      "json",
      "--log-level",
      "error",
    ],
    { env, encoding: "utf8", timeout: 25_000 },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const archivedInstalls: { version: string; output: string }[] = [];
  for (const version of ["1.4.0", "1.4.2", "1.4.3"]) {
    const archived = spawnSync(
      binary,
      [
        "harness",
        "install",
        fileURLToPath(
          new URL(
            `../harnesses/legacy/script-studio-${version}.hns`,
            import.meta.url,
          ),
        ),
        "--cwd",
        runtimeDirectory,
        "--config-file",
        configFile,
        "--format",
        "json",
        "--log-level",
        "error",
      ],
      { env, encoding: "utf8", timeout: 25_000 },
    );
    assert.equal(archived.status, 0, archived.stderr);
    archivedInstalls.push({ version, output: archived.stdout });
  }
  const registered = spawnSync(
    binary,
    [
      "harness",
      "list",
      "--cwd",
      runtimeDirectory,
      "--config-file",
      configFile,
      "--format",
      "json",
      "--log-level",
      "error",
    ],
    { env, encoding: "utf8", timeout: 25_000 },
  );
  assert.equal(registered.status, 0, registered.stderr);
  for (const version of ["1.4.0", "1.4.2", "1.4.3", "1.4.4"])
    assert.ok(
      registered.stdout.includes(version),
      `Frozen package ${version} stays registered`,
    );
  evidence.harness = {
    ...scriptStudioApplication.harness,
    sourceSha256: createHash("sha256")
      .update(readFileSync(harnessFile))
      .digest("hex"),
    installationOutput: installed.stdout,
    archivedInstalls,
    registry: registered.stdout,
    realModelValidation: false,
  };
  assert.equal(
    requests.length,
    0,
    "Installing Harness does not invoke the provider",
  );
  runtime = spawn(
    binary,
    [
      "serve",
      "--bind",
      `127.0.0.1:${port}`,
      "--cwd",
      runtimeDirectory,
      "--config-file",
      configFile,
      "--log-level",
      "warn",
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream.on("data", (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-30_000);
    });
  await wait(
    () =>
      host!.connection.application.options.runtime!.platformStatus().connected,
    "Runtime connection",
  );
  const capabilityResponse = await fetch(
    `http://127.0.0.1:${port}/api/session-io/capabilities`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.ok(capabilityResponse.ok);
  const capabilities = (await capabilityResponse.json()) as {
    harnesses: { id: string; version: string }[];
  };
  assert.ok(
    capabilities.harnesses.some(
      (entry) =>
        entry.id === scriptStudioApplication.harness!.id &&
        entry.version === scriptStudioApplication.harness!.version,
    ),
    "The running Runtime, not just the offline install command, must load the exact current package",
  );
  evidence.liveHarnesses = capabilities.harnesses;
  const bound = await fetch(
    `http://127.0.0.1:${port}/api/agents/default-agent/provider-accounts/stub`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
  );
  assert.ok(bound.ok, `Isolated account binding failed: ${bound.status}`);
  const client = await PlatformClient.connect(host.connection);
  const projectId = randomUUID(),
    productionId = randomUUID(),
    conversationId = randomUUID();
  await client.createProject(
    "TEST 多条目真实 Runtime 工序",
    randomUUID(),
    projectId,
  );
  const created = (await client.createScript({
    commandId: randomUUID(),
    projectId,
    productionId,
    title: "TEST 领证前夜",
  })) as { contentId: string };
  const contentId = created.contentId,
    initial = await client.readScriptSnapshot(contentId);
  await client.updateScript({
    commandId: randomUUID(),
    contentId,
    expectedRevision: (await client.readScript(contentId)).metadataRevision,
    title: initial.title,
    brief: {
      ...initial.brief,
      constraints:
        "只交付两位主角设定和五场戏大纲；每项一个候选，合计6000字符，一轮自审，不自动采纳或批准。",
    },
    reviewerPrincipalIds: initial.reviewerPrincipalIds,
    template: initial.template,
  });
  const targets: string[] = [];
  for (const [kind, title] of [
    ["character", "主角一"],
    ["character", "主角二"],
    ["outline", "五场戏大纲"],
  ] as const) {
    const itemId = randomUUID();
    await client.createScriptItem({
      commandId: randomUUID(),
      contentId,
      itemId,
      expectedActivityRevision: (await client.readScript(contentId))
        .activityRevision,
      kind,
      draft: { ...emptyScriptDraft(title), sources: [] },
    });
    targets.push(itemId);
  }
  const app = await client.launchAppView({
    commandId: randomUUID(),
    projectId,
    appId: scriptStudioApplication.id,
    packageVersion: scriptStudioApplication.version,
    state: {},
  });
  const baseline = await client.readScriptSnapshot(contentId);
  assert.equal(baseline.brief.modelProcessingAllowed, false);
  assert.equal(baseline.brief.rightsStatement, "");
  const deliveries = () =>
    (
      host!.connection.application.store.runtimeState() as {
        deliveries: Delivery[];
      }
    ).deliveries;
  const submit = async (body: string, first = false) => {
    const receipt = (await host!.connection.call(
      "platform.message",
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId,
          conversationId,
          ...(first
            ? { newConversation: { title: "TEST 一个 Session 三份交付" } }
            : {}),
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body,
          targetActantId: "morphz-agent",
          applicationInstanceId: app.id,
          application: {
            id: scriptStudioApplication.id,
            version: scriptStudioApplication.version,
          },
        },
      },
      { identityGeneration: client.boot.csrfToken },
    )) as Receipt;
    await wait(() => {
      const delivery = deliveries().find(
        (entry) => entry.inputId === receipt.entityId,
      );
      if (delivery?.state === "failed")
        throw new Error(`Runtime delivery failed: ${delivery.error}`);
      return delivery?.state === "completed";
    }, "actual Runtime delivery");
    const delivery = deliveries().find(
      (entry) => entry.inputId === receipt.entityId,
    )!;
    assert.equal(
      delivery.platformSource?.body ?? delivery.platformSource?.text,
      body,
    );
    assert.equal(
      delivery.platformSource?.scriptGeneration,
      undefined,
      "Do not preload or rewrite scope",
    );
    assert.ok(delivery.rootId);
    const events = sql<RuntimeEvent>(
      join(runtimeDirectory, "runtime.sqlite"),
      "SELECT id,type,context_id,session_id,root_turn_id,payload FROM events ORDER BY rowid",
    );
    const reply = events
      .filter(
        (event) =>
          event.type === "agent_call" &&
          event.root_turn_id === delivery.rootId &&
          event.session_id === delivery.sessionId &&
          event.id.startsWith("reply_"),
      )
      .at(-1);
    assert.ok(
      reply,
      "Actual persisted reply, not provider echo or Thread status",
    );
    return {
      inputId: receipt.entityId,
      body,
      rootId: delivery.rootId,
      text: String(JSON.parse(reply.payload).text),
      contextId: reply.context_id,
      sessionId: reply.session_id,
      events,
    };
  };
  const proposal = await submit(
    "TEST 合成验收：先只讨论《领证前夜》，建议下一步做两位主角设定和五场戏大纲；三个现有条目是主角一、主角二、五场戏大纲。等我确认才生成并分别保存，每项一个候选，一轮自审，合计6000字符，不写完整正文，不自动采纳或批准。",
    true,
  );
  assert.equal(proposal.text, proposalText);
  assertNoCreativeWrites(await client.readScriptSnapshot(contentId), baseline);
  const confirmation = await submit(confirmationBody);
  assert.equal(confirmation.contextId, proposal.contextId);
  assert.equal(confirmation.sessionId, proposal.sessionId);
  const preparations = sql<Preparation>(
    join(appDirectory, "script-studio.sqlite"),
    "SELECT input_id,target_item_id,base_item_revision,task_request FROM script_preparations WHERE input_id=? ORDER BY collection_ordinal",
    confirmation.inputId,
  );
  const receipts = sql<CommandReceipt>(
    join(appDirectory, "script-studio.sqlite"),
    "SELECT operation,result_object_id,input_id,result_version_ref FROM script_command_receipts WHERE input_id=? ORDER BY committed_at,command_id",
    confirmation.inputId,
  );
  const final = await client.readScriptSnapshot(contentId);
  assert.deepEqual(
    final.brief,
    baseline.brief,
    "Agent creation neither needs nor rewrites the retired consent metadata",
  );
  evidence.retiredPermission = {
    modelProcessingAllowed: final.brief.modelProcessingAllowed,
    rightsStatement: final.brief.rightsStatement,
    metadataUnchanged: true,
  };
  evidence.inputs = [proposal, confirmation].map(
    ({ events: _events, ...input }) => input,
  );
  evidence.preparations = preparations;
  evidence.receipts = receipts;
  evidence.candidates = final.candidates;
  evidence.formalTargets = final.items;
  assertThreeCandidateDeliveries(
    final,
    confirmation.inputId,
    targets,
    preparations,
    receipts,
  );
  assert.equal(preparations[0]!.task_request, task);
  assert.equal(
    receipts.filter((receipt) => receipt.operation === "prepare-generation")
      .length,
    1,
    "One atomic preparation receipt freezes the whole batch",
  );
  assert.equal(
    receipts.filter((receipt) => receipt.operation === "submit-candidate")
      .length,
    3,
  );
  const counts = Object.fromEntries(
    [
      "discussion",
      "prepare",
      "create",
      "review",
      "revise",
      "delivery",
      "relay",
    ].map((stage) => [
      stage,
      [...logical.values()].filter((value) => value === stage).length,
    ]),
  );
  assert.deepEqual(counts, {
    discussion: 2,
    prepare: 1,
    create: 1,
    review: 1,
    revise: 0,
    delivery: 1,
    relay: 2,
  });
  const prepareEvents = confirmation.events.filter(
    (event) =>
      event.type === "infer_request" &&
      String(JSON.parse(event.payload).request?.program).includes(
        "STAGE script-prepare",
      ),
  );
  assert.equal(prepareEvents.length, 1);
  assert.match(
    JSON.parse(prepareEvents[0]!.payload).request.program,
    /无需额外启用Agent或确认模型处理许可/,
    "The actual persisted model step must receive the retired-gate rule",
  );
  const captured = JSON.parse(prepareEvents[0]!.payload).request.captures;
  assert.equal(captured.input.body, confirmationBody);
  assert.equal(captured.intent.$yao.fields.task, task);
  assert.equal(captured.intent.$yao.fields.execute, true);
  const actualPlans = sql<{
    harness_id: string;
    harness_version: string;
    status: string;
  }>(
    join(runtimeDirectory, "runtime.sqlite"),
    "SELECT p.harness_id,p.harness_version,p.status FROM plan_executions p JOIN threads t ON t.id=p.thread_id WHERE t.root_turn_id=? AND p.harness_id IS NOT NULL",
    confirmation.rootId,
  );
  assert.ok(actualPlans.length > 0);
  for (const plan of actualPlans) {
    assert.equal(plan.harness_id, scriptStudioApplication.harness!.id);
    assert.equal(
      plan.harness_version,
      scriptStudioApplication.harness!.version,
    );
    assert.equal(plan.status, "succeeded");
  }
  evidence.actualPlans = actualPlans;
  const inferenceCaptures = (stage: string) => {
    const events = confirmation.events.filter(
      (event) =>
        event.type === "infer_request" &&
        String(JSON.parse(event.payload).request?.program).includes(
          `STAGE script-${stage}`,
        ),
    );
    assert.equal(
      events.length,
      1,
      `One actual ${stage} inference for the whole batch`,
    );
    return JSON.parse(events[0]!.payload).request.captures;
  };
  const creative = inferenceCaptures("create").context;
  assert.equal(creative.brief.modelProcessingAllowed, false);
  assert.equal(creative.brief.rightsStatement, "");
  assert.equal(creative.outputSchema.type, "array");
  assert.equal(creative.task, task);
  assert.deepEqual(
    creative.targets.map(
      (entry: { target: { itemId: string } }) => entry.target.itemId,
    ),
    targets,
  );
  const review = inferenceCaptures("review");
  assert.equal(review.round, 1);
  assert.equal(review.product.$yao.fields.payload.length, 3);
  assert.deepEqual(
    review.product.$yao.fields.payload.map(
      (entry: { targetId: string }) => entry.targetId,
    ),
    targets,
  );
  const actualReceipt = inferenceCaptures("delivery").receipt;
  assert.equal(actualReceipt.ok, true);
  assert.equal(actualReceipt.kind, "candidates");
  assert.equal(actualReceipt.inputId, confirmation.inputId);
  assert.equal(actualReceipt.reviewPasses, 1);
  assert.equal(actualReceipt.savedCount, 3);
  assert.deepEqual(
    actualReceipt.results.map(
      (result: { targetId: string }) => result.targetId,
    ),
    targets,
  );
  for (const result of actualReceipt.results) {
    assert.equal(result.status, "saved");
    assert.equal(result.saved, true);
    const candidate = final.candidates.find(
      (candidate) => candidate.id === result.candidateId,
    );
    assert.ok(
      candidate,
      "Final relay receives the actual domain candidate, not a generated receipt",
    );
    assert.equal(candidate.targetId, result.targetId);
    assert.equal(result.receipt.entityId, candidate.id);
    assert.ok(
      receipts.some((receipt) => receipt.result_object_id === candidate.id),
    );
  }
  evidence.actualWorkflowReceipt = actualReceipt;
  const contentDeliveries = await client.contentDeliveries([
    confirmation.inputId,
  ]);
  assert.equal(
    contentDeliveries.length,
    3,
    "Platform projection links come from three actual receipts",
  );
  evidence.contentDeliveries = contentDeliveries;
  evidence.logicalStages = counts;
  evidence.providerRequests = requests.length;
  evidence.passed = true;
  save("evidence.json", evidence);
  console.log(
    JSON.stringify({
      passed: true,
      providerRequests: requests.length,
      logicalStages: counts,
      candidateCount: 3,
      evidenceDirectory: directory,
    }),
  );
} catch (error) {
  evidence.passed = false;
  evidence.failure = error instanceof Error ? error.message : String(error);
  evidence.providerRequests = requests.length;
  save("evidence.json", evidence);
  save("runtime-log.json", { text: logs });
  throw error;
} finally {
  if (runtime?.exitCode === null) {
    runtime.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((done) => runtime!.once("exit", () => done())),
      pause(5_000),
    ]);
    if (runtime.exitCode === null) runtime.kill("SIGKILL"); // Only the runner's isolated owned child.
  }
  await host?.close();
  provider.closeAllConnections();
  if (provider.listening)
    await new Promise<void>((done) => provider.close(() => done()));
}
