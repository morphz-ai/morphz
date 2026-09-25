/** Opt-in real-model evaluation; isolated data, real Harness/Runtime/Host, no simulated writer.
 * Requires MORPHZ_SCRIPT_QUALITY_BASE_URL, MODEL, KEY and optional PROTOCOL (openai-responses).
 * Evidence contains synthetic fixture prose and tool receipts, never credentials.
 * Mechanical checks are not a professional editorial score; read every saved result.
 */
import "./application-configuration.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { receivedWorkflowText } from "./script-studio-quality-evidence.js";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import {
  localAccess,
  type Operation,
  type Receipt,
} from "../packages/core/src/model.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import {
  emptyScriptDraft,
  currentScriptDraft,
  scriptBriefSchema,
  type ScriptCommand,
  type ScriptDraft,
  type ScriptGeneration,
} from "../packages/core/src/script-studio.js";

const model = process.env.MORPHZ_SCRIPT_QUALITY_MODEL;
const baseUrl = process.env.MORPHZ_SCRIPT_QUALITY_BASE_URL;
const key = process.env.MORPHZ_SCRIPT_QUALITY_KEY;
const protocol =
  process.env.MORPHZ_SCRIPT_QUALITY_PROTOCOL ?? "openai-responses";
assert.ok(
  model && baseUrl && key,
  "Explicit real-model configuration is required. This script incurs model usage.",
);
assert.ok(["openai-responses", "openai-chat"].includes(protocol));
const canonicalHarness = readFileSync(
  new URL("../harnesses/script-studio.hns", import.meta.url),
  "utf8",
);
assert.equal(
  /\(version "([^"]+)"\)/.exec(canonicalHarness)?.[1],
  scriptStudioApplication.harness?.version,
  "The builtin must reference the canonical Harness being evaluated",
);
const cases = z
  .array(
    z
      .object({
        key: z.string(),
        title: z.string(),
        kind: z.enum(["episode", "scene", "outline", "setting"]),
        purpose: z.enum(["draft", "rewrite", "continuity", "impact"]),
        brief: scriptBriefSchema.omit({
          rightsStatement: true,
          modelProcessingAllowed: true,
        }),
        parent: z.string().optional(),
        setting: z.string().optional(),
        source: z.string().optional(),
        downstream: z.string().optional(),
        hiddenDownstream: z.string().optional(),
        text: z.string(),
        request: z.string(),
        checks: z.array(z.string()),
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../tests/fixtures/script-studio-quality-cases.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
const selected = process.env.MORPHZ_SCRIPT_QUALITY_CASES?.split(",");
const fixtures = selected
  ? cases.filter((c) => selected.includes(c.key))
  : cases;
assert.ok(fixtures.length > 0);
if (selected)
  assert.equal(
    fixtures.length,
    new Set(selected).size,
    "Unknown quality fixture key",
  );
const directory = mkdtempSync(join(tmpdir(), "morphz-script-quality-"));
const runtimeDirectory = join(directory, "runtime");
const appDirectory = join(directory, "application");
for (const path of [runtimeDirectory, appDirectory])
  mkdirSync(path, { mode: 0o700 });
const runtimeToken = randomBytes(32).toString("hex");
let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
let runtime: ChildProcess | undefined;
let runtimeLogs = "";
const secrets = [runtimeToken, key];
const redact = (text: string) =>
  secrets.reduce((s, secret) => s.split(secret).join("[redacted]"), text);
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), redact(JSON.stringify(value, null, 2)), {
    mode: 0o600,
  });
const results: unknown[] = [];
console.log(
  JSON.stringify({
    evidenceDirectory: directory,
    model,
    harness: scriptStudioApplication.harness,
    fixtures: fixtures.map((c) => c.key),
  }),
);
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitUntil(
  check: () => boolean,
  label: string,
  timeout = 60_000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    if (runtime && (runtime.exitCode !== null || runtime.signalCode !== null))
      throw new Error(`Isolated Runtime exited during ${label}`);
    await delay(500);
  }
  throw new Error(`${label} timed out`);
}
try {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  writeFileSync(
    join(appDirectory, "runtime.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      token: runtimeToken,
      namespace: randomUUID(),
    }),
    { mode: 0o600 },
  );
  const configFile = join(runtimeDirectory, "morphz.toml");
  writeFileSync(
    configFile,
    `[llm]\nmodel=${JSON.stringify(model)}\nreasoning_effort="low"\n[accounts.quality]\nauth_adapter="credential"\ncredential_ref="quality"\nprovider="quality"\n[services.quality]\nadapter="protocol-compatible"\nprotocol=${JSON.stringify(protocol)}\nbase_url=${JSON.stringify(baseUrl)}\naccounts=["quality"]\n[models.${JSON.stringify(model)}]\n[[models.${JSON.stringify(model)}.targets]]\nservice="quality"\naccount="quality"\nphysical_model=${JSON.stringify(model)}\ncapabilities=["tools"]\n[credentials.quality]\nsource="env"\nname="MORPHZ_SCRIPT_QUALITY_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeDirectory)}\n[background_task]\nartifact_dir=${JSON.stringify(join(runtimeDirectory, "artifacts"))}\n`,
    { mode: 0o600 },
  );
  process.env.MORPHZ_APP_ENV_FILE = "";
  host = await openEmbeddedApplication(
    appDirectory,
    join(directory, "profile"),
  );
  const manifest = JSON.parse(readFileSync(host.manifestPath!, "utf8"));
  secrets.push(...manifest.tools.map((tool: { token: string }) => tool.token));
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    MORPHZ_HOME: runtimeDirectory,
    MORPHZ_STORAGE_SQLITE_PATH: join(runtimeDirectory, "runtime.sqlite"),
    MORPHZ_DASHBOARD_TOKEN: runtimeToken,
    MORPHZ_HOST_TOOLS_FILE: host.manifestPath,
    MORPHZ_EVAL_CALLABLE_TOOLS: "host_morphz",
    MORPHZ_SCRIPT_QUALITY_KEY: key,
  };
  const binary = runtimeBinaryPath();
  for (const file of [
    "legacy/script-studio-1.2.1.hns",
    "legacy/script-studio-1.2.0.hns",
    "legacy/script-studio-1.1.1.hns",
    "legacy/script-studio-1.0.0.hns",
    "legacy/script-studio-1.1.0.hns",
    "script-studio.hns",
  ]) {
    const installed = spawnSync(
      binary,
      [
        "harness",
        "install",
        fileURLToPath(new URL(`../harnesses/${file}`, import.meta.url)),
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
    assert.equal(
      installed.status,
      0,
      redact(installed.stderr + installed.stdout),
    );
  }
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
    { env, stdio: "pipe" },
  );
  for (const stream of [runtime.stdout, runtime.stderr])
    stream?.on("data", (chunk: Buffer) => {
      runtimeLogs = (runtimeLogs + chunk.toString()).slice(-40_000);
    });
  await waitUntil(
    () => host!.connection.application.options.runtime!.snapshot().connected,
    "Runtime connection",
  );
  const bound = await fetch(
    `http://127.0.0.1:${port}/api/agents/default-agent/provider-accounts/quality`,
    { method: "PUT", headers: { Authorization: `Bearer ${runtimeToken}` } },
  );
  assert.ok(bound.ok, `Test-only account binding failed: ${bound.status}`);
  const boot = (await host.connection.call("workspace")) as {
    csrfToken: string;
  };
  const execute = (operation: Operation) =>
    host!.connection.application.store.execute(
      { commandId: randomUUID(), operation },
      localAccess,
    ).entityId;
  const run = (command: ScriptCommand) =>
    execute({ type: "script-command", command });
  for (const fixture of fixtures) {
    const startedAt = new Date().toISOString();
    // Independent project gives each case an independent Session and no earlier test answers.
    const projectId = execute({
      type: "create-project",
      title: `TEST 编剧质量 ${fixture.title}`,
    });
    const productionId = run({
      action: "create-production",
      projectId,
      title: `TEST ${fixture.title}`,
    });
    const production = () =>
      host!.connection.application.store
        .snapshot()
        .scriptProductions.find((p) => p.id === productionId)!;
    const p = production();
    run({
      action: "update-production",
      productionId,
      expectedRevision: p.revision,
      title: p.title,
      brief: {
        ...fixture.brief,
        modelProcessingAllowed: true,
        rightsStatement:
          "助手原创合成验收素材，不含真实客户原作；允许当前已配置模型处理。",
      },
      reviewerPrincipalIds: p.reviewerPrincipalIds,
      template: p.template,
    });
    const create = (
      kind: "episode" | "scene" | "outline" | "setting",
      text: string,
      patch: Partial<ScriptDraft> = {},
    ) =>
      run({
        action: "create-item",
        productionId,
        kind,
        draft: {
          ...emptyScriptDraft(`${fixture.title} · ${kind}`),
          text,
          ...patch,
        },
      });
    const references: ScriptGeneration["references"] = [];
    const dependencies: ScriptDraft["dependencies"] = [];
    const parentId = fixture.parent ? create("episode", fixture.parent) : null;
    if (parentId) {
      references.push({ itemId: parentId, revision: 1 });
      dependencies.push({ itemId: parentId, revision: 1 });
    }
    if (fixture.setting) {
      const itemId = create("setting", fixture.setting);
      references.push({ itemId, revision: 1 });
      dependencies.push({ itemId, revision: 1 });
    }
    const sources: ScriptDraft["sources"] = [];
    if (fixture.source) {
      const artifactId = execute({
        type: "create-artifact",
        projectId,
        title: "TEST 合成原作",
        content: { kind: "document", markdown: fixture.source },
      });
      sources.push({ artifactId, revision: 1, quote: "" });
    }
    const targetId = create(fixture.kind, fixture.text, {
      parentId,
      dependencies,
      sources,
      basis: fixture.brief.mode === "adaptation" ? "adaptation" : "original",
    });
    if (fixture.downstream) {
      const itemId = create("episode", fixture.downstream, {
        dependencies: [{ itemId: targetId, revision: 1 }],
      });
      references.push({ itemId, revision: 1 });
    }
    if (fixture.hiddenDownstream)
      create("episode", fixture.hiddenDownstream, {
        dependencies: [{ itemId: targetId, revision: 1 }],
      });
    const originals = structuredClone(production().items);
    const artifactCount =
      host.connection.application.store.snapshot().artifacts.length;
    const applicationInstanceId = execute({
      type: "launch-application",
      workspaceId: projectId,
      applicationId: scriptStudioApplication.id,
      applicationVersion: scriptStudioApplication.version,
    });
    const generation: ScriptGeneration = {
      productionId,
      targetId,
      baseRevision: 1,
      contextRevision: production().revision,
      purpose: fixture.purpose,
      references,
      maxCandidates: 1,
      maxOutputCharacters: 8000,
      maxReviewPasses: 1,
    };
    const body = `TEST 专业编剧质量验收（合成素材）。${fixture.request}\n使用本次固定的剧本请求与资料版本，将成果提交为候选或带引用的审阅意见。不得覆盖正式稿、代替人工批准或创建无关对象。`;
    const receipt = (await host.connection.call(
      "message",
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body,
          targetActantId: "morphz-agent",
          applicationInstanceId,
          scriptGeneration: generation,
        },
      },
      { identityGeneration: boot.csrfToken },
    )) as Receipt;
    console.log(
      JSON.stringify({
        case: fixture.key,
        status: "submitted",
        inputId: receipt.entityId,
      }),
    );
    await waitUntil(
      () => {
        const d = host!.connection.application.options
          .runtime!.snapshot()
          .deliveries.find((d) => d.inputId === receipt.entityId);
        if (d?.state === "failed")
          throw new Error(`${fixture.key}: ${d.error ?? "delivery failed"}`);
        return d?.state === "completed";
      },
      `${fixture.key} model completion`,
      10 * 60_000,
    );
    const state = host.connection.application.store.snapshot();
    const input = state.inputs.find((i) => i.id === receipt.entityId)!;
    const delivery = host.connection.application.options
      .runtime!.snapshot()
      .deliveries.find((d) => d.inputId === input.id)!;
    const db = new DatabaseSync(join(runtimeDirectory, "runtime.sqlite"), {
      readOnly: true,
    });
    const jobs = db
      .prepare(
        "SELECT id,thread_id,tool_name,request_json,status,error FROM execution_jobs WHERE created_at >= ? ORDER BY created_at",
      )
      .all(startedAt);
    const activations = db
      .prepare(
        "SELECT id,model_alias,reasoning_effort,status FROM thread_activations WHERE created_at >= ? ORDER BY created_at",
      )
      .all(startedAt);
    const plans = db
      .prepare(
        "SELECT id,harness_id,harness_version,status,error FROM plan_executions WHERE created_at >= ? ORDER BY created_at",
      )
      .all(startedAt);
    const inferencePrograms = db
      .prepare(
        "SELECT payload FROM events WHERE type = 'infer_request' AND timestamp >= ? ORDER BY timestamp",
      )
      .all(startedAt)
      .map((row) => JSON.parse(String(row.payload)).request?.program as string);
    const stages = inferencePrograms.map(
      (program) => /STAGE script-(\w+)/.exec(program)?.[1],
    );
    // Physical job success can still contain a domain validation error. Keep
    // real tool outputs too, including rejected attempts followed by recovery.
    const toolOutputs = db
      .prepare(
        "SELECT payload FROM events WHERE type = 'tool_output' AND timestamp >= ? ORDER BY timestamp",
      )
      .all(startedAt)
      .map((row) => JSON.parse(String(row.payload)));
    db.close();
    const end = production();
    const candidates = end.candidates.filter((c) => c.inputId === input.id);
    const reviews = end.reviews.filter((r) => r.inputId === input.id);
    const mechanical: Record<string, boolean> = {
      exactHarness:
        JSON.stringify(input.application?.harness) ===
        JSON.stringify(scriptStudioApplication.harness),
      formalDraftsUntouched:
        // Blocking reviews legitimately append workflow invalidation events.
        // Formal text and its entire immutable version history must not change.
        JSON.stringify(
          end.items.map(({ id, kind, revision, versions }) => ({
            id,
            kind,
            revision,
            versions,
          })),
        ) ===
        JSON.stringify(
          originals.map(({ id, kind, revision, versions }) => ({
            id,
            kind,
            revision,
            versions,
          })),
        ),
      noAutomaticApproval: end.items.every(
        (i) => i.approval === null && i.status === "draft",
      ),
      noUnrelatedArtifacts: state.artifacts.length === artifactCount,
      appropriateResult:
        fixture.purpose === "draft" || fixture.purpose === "rewrite"
          ? candidates.length === 1 &&
            candidates.every((c) => c.status === "pending")
          : reviews.length > 0 && candidates.length === 0,
      outputBudget: candidates.every(
        (c) => JSON.stringify(c.draft).length <= generation.maxOutputCharacters,
      ),
      realQuotes: reviews.every((r) =>
        originals
          .find((i) => i.id === r.itemId)
          ?.versions.find((v) => v.revision === r.itemRevision)
          ?.draft.text.includes(r.quote),
      ),
      durableYaoExecution:
        plans.length === 1 &&
        plans[0]?.status === "succeeded" &&
        plans[0]?.harness_version === scriptStudioApplication.harness?.version,
      actualReview:
        stages.filter((stage) => stage === "review").length ===
        generation.maxReviewPasses,
      boundedRevision:
        stages.filter((stage) => stage === "revise").length <=
        generation.maxReviewPasses,
      orderedStages:
        stages[0] === "intent" &&
        stages[1] === "create" &&
        stages.at(-1) === "delivery",
    };
    const prose = candidates[0]?.draft.text ?? "";
    if (fixture.key === "rewrite") {
      const nonDialogue = (s: string) =>
        s
          .split("\n")
          .filter((line) => line.trim() && !/^(乔雨|陈野)：/.test(line));
      mechanical.nonDialogueVerbatim =
        JSON.stringify(nonDialogue(prose)) ===
        JSON.stringify(nonDialogue(fixture.text));
      mechanical.fourDialogueTurns =
        prose.split("\n").filter((line) => /^(乔雨|陈野)：/.test(line))
          .length === 4;
    }
    if (fixture.key === "adaptation") {
      mechanical.actualSourceRead = receivedWorkflowText(
        toolOutputs,
        fixture.source!,
        "source",
      );
      // Literal inscription is mechanically checkable. Sound count belongs in
      // the editorial checklist: “一声…又一声” also preserves exactly two sounds.
      mechanical.specificInscriptionPreserved = prose.includes("澄字第七号");
    }
    if (fixture.key === "impact") {
      mechanical.actualImpactRead = receivedWorkflowText(
        toolOutputs,
        fixture.downstream!,
        "draft",
      );
      mechanical.hiddenMaterialNotQuoted = !JSON.stringify({
        candidates,
        reviews,
      }).includes("HIDDEN-IMPACT-0919");
    }
    const result = {
      fixture: fixture.key,
      title: fixture.title,
      startedAt,
      completedAt: new Date().toISOString(),
      model,
      harness: input.application?.harness,
      input,
      generation,
      brief: production().brief,
      materials: originals,
      sourceText: fixture.source ?? null,
      productionId,
      targetId,
      delivery,
      messages: host.connection.application.options
        .runtime!.snapshot()
        .messages.filter((m) => m.inputId === input.id),
      candidates,
      reviews,
      jobs,
      activations,
      plans,
      stages,
      toolOutputs,
      mechanical,
      editorialChecklist: fixture.checks,
      editorialStatus: "requires-full-text-human-or-reviewer-inspection",
    };
    save(`${fixture.key}.json`, result);
    results.push({ case: fixture.key, inputId: input.id, mechanical });
    save("summary.json", {
      model,
      harness: scriptStudioApplication.harness,
      results,
      note: "Mechanical checks are not an editorial score or a claim about the user's Desktop window.",
    });
    console.log(
      JSON.stringify({ case: fixture.key, status: "completed", mechanical }),
    );
  }
  assert.ok(
    results.every((r) =>
      Object.values(
        (r as { mechanical: Record<string, boolean> }).mechanical,
      ).every(Boolean),
    ),
    "Mechanical failures exist; inspect evidence. Do not count editorial checks as passed.",
  );
} catch (error) {
  save("failure.json", { error: String(error), runtimeLogs });
  console.error(redact(String(error)));
  process.exitCode = 1;
} finally {
  // Closing one resource must not prevent teardown of the isolated child.
  try {
    await host?.close();
  } catch (error) {
    console.error(redact(`Isolated Host teardown failed: ${String(error)}`));
    process.exitCode = 1;
  } finally {
    if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
      const child = runtime;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        // Only the fresh child created by this script, never an existing Runtime.
        child.kill("SIGKILL");
        process.exitCode = 1;
      }, 10_000);
      await exited;
      clearTimeout(timer);
    }
  }
  save("runtime-log.json", { log: runtimeLogs });
  console.log(
    JSON.stringify({
      evidenceDirectory: directory,
      finishedCases: results.length,
      status: process.exitCode
        ? "failed"
        : "mechanical-checks-passed-editorial-review-required",
    }),
  );
}
