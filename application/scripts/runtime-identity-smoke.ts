/** Real Runtime, real Work HTTP and isolated identities. Model responses are deterministic;
 * this test never loads a personal database, .env or a paid model endpoint. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import { IdentityCenter } from "../apps/service/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  prepareHostTools,
  runtimeAgentTools,
} from "../apps/service/src/agent-tools.js";
import type { AccessContext } from "../packages/core/src/model.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "morphz-identity-")),
  root = join(directory, "runtime");
mkdirSync(root, { mode: 0o700 });
const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
  mode: "transport",
});
const people = [
  { principalId: "alpha", actantId: "alpha-human" },
  { principalId: "beta", actantId: "beta-human" },
];
const projects = people.map(
  () => `project_${randomUUID().replaceAll("-", "")}`,
);
const members = people.map((p, i) => ({
  ...p,
  name: `测试成员 ${i + 1}`,
  enabled: true,
  projectIds: ["first-project", projects[i]!],
}));
const tokens = people.map(() => randomBytes(32).toString("hex")),
  configuration = {
    version: 1,
    members: people.map((p, i) => ({
      ...p,
      enabled: true,
      loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
    })),
  };
const identity = new IdentityCenter(store, configuration);
const domains = await openApplicationDomainsHost(directory, store, identity);
const create = (access: AccessContext, projectId: string, title: string) =>
  domains.work.authority.withSession(
    access,
    () => {},
    (actor) =>
      domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId,
        title,
      }),
  );
await create(people[0]!, "first-project", "共享项目");
for (const [i, person] of people.entries())
  await create(person, projects[i]!, `私有项目 ${i + 1}`);
await identity.replaceConfiguration(configuration, members);
const requests: string[] = [],
  toolProjects = new Set<string>(),
  rememberedProjects = new Set<string>();
const provider = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  const input = JSON.stringify(data.messages);
  requests.push(input);
  const marker = ["ALPHA_PRIVATE_MARKER", "BETA_PRIVATE_MARKER"].find((v) =>
    input.includes(v),
  );
  let call =
    marker && !toolProjects.has(marker)
      ? {
          id: `call-${marker}`,
          type: "function",
          function: {
            name: "host_morphz",
            arguments: JSON.stringify({
              action: "create-document",
              title: marker,
              markdown: "由对应项目的真实 Runtime 执行任务创建。",
            }),
          },
        }
      : null;
  if (call) toolProjects.add(marker!);
  if (!call && marker && !rememberedProjects.has(marker)) {
    const person = marker === "ALPHA_PRIVATE_MARKER" ? 0 : 1;
    const saved = store.runtimeState() as {
      sessions: Record<string, { id: string; projectId: string }>;
    };
    const session = Object.values(saved.sessions).find(
      (session) => session.projectId === projects[person],
    )!;
    const context = await fetch(
      `${runtimeURL}/api/sessions/${session.id}/context`,
      {
        headers: {
          Authorization: `Bearer ${gateway}`,
          "X-Morphz-Principal": bridge.principalId(people[person]!.principalId),
        },
      },
    ).then((r) => r.json());
    assert.equal(typeof context.state.version, "number");
    call = {
      id: `remember-${marker}`,
      type: "function",
      function: {
        name: "context_tx",
        arguments: JSON.stringify({
          transaction: `(context-tx (base-version ${context.state.version}) (create test-reading-memory (kind "synthetic reading acceptance") (understanding "${marker}_UNDERSTANDING") (source "TEST book / chapter 1 / synthetic quote")))`,
        }),
      },
    };
    rememberedProjects.add(marker);
  }
  const message = call
    ? { role: "assistant", content: "", tool_calls: [call] }
    : { role: "assistant", content: "隔离测试：已收到。" };
  if (data.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ ...call, index: 0 }] } : message, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: randomUUID(),
        choices: [
          { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
        ],
      }),
    );
  }
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const portOf = (s: ReturnType<typeof createServer>) =>
  (s.address() as { port: number }).port;
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = portOf(s);
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const runtimePort = await freePort(),
  workPort = await freePort(),
  runtimeURL = `http://127.0.0.1:${runtimePort}`,
  origin = `http://127.0.0.1:${workPort}`;
const gateway = randomBytes(32).toString("hex"),
  operator = randomBytes(32).toString("hex"),
  configFile = join(root, "morphz.toml");
const namespace = randomUUID(),
  manifest = prepareHostTools(directory, workPort, namespace, true);
writeFileSync(
  configFile,
  `[llm]\nmodel="test-model"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${portOf(provider)}/v1"\naccounts=["stub"]\n[[models.test-model.targets]]\nservice="stub"\naccount="stub"\nphysical_model="test-model"\ncapabilities=["tools"]\n[credentials.stub]\nsource="env"\nname="TEST_MODEL_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(root)}\n[server.identity]\nmode="trusted-gateway"\nprovider_id="morphz-test"\nservice_token_env="TEST_GATEWAY_TOKEN"\n`,
  { mode: 0o600 },
);
const runtime = spawn(
  runtimeBinaryPath(),
  [
    "serve",
    "--bind",
    `127.0.0.1:${runtimePort}`,
    "--cwd",
    root,
    "--config-file",
    configFile,
    "--log-level",
    "warn",
  ],
  {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      MORPHZ_HOME: root,
      MORPHZ_STORAGE_SQLITE_PATH: join(root, "runtime.sqlite"),
      MORPHZ_HOST_TOOLS_FILE: manifest.path,
      MORPHZ_DASHBOARD_TOKEN: operator,
      TEST_GATEWAY_TOKEN: gateway,
      TEST_MODEL_KEY: "synthetic",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
for (const s of [runtime.stdout, runtime.stderr])
  s.on("data", (c) => {
    logs = (logs + c.toString()).slice(-8000);
  });
const config = {
  url: runtimeURL,
  token: gateway,
  namespace,
  identityMode: "trusted_gateway" as const,
};
let bridge = new RuntimeBridge(store, config, identity);
let bound = domains.bindRuntime(bridge);
const server = createAppServer(store, {
  port: workPort,
  webRoot: resolve("dist/web"),
  identity,
  runtime: bridge,
  platformWork: domains.work,
  platformDocuments: domains.content,
  platformReader: domains.reader,
  agentTools: runtimeAgentTools(bridge, manifest.token, {
    authority: bound.authority,
    work: domains.work.service,
    content: domains.content,
    reader: domains.reader.service,
  }),
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(runtimeURL + "/health")).ok) break;
    } catch {}
    assert.ok(i < 100 && runtime.exitCode === null, "Runtime 未就绪：" + logs);
    await delay(100);
  }
  const binding = await fetch(
    `${runtimeURL}/api/agents/default-agent/provider-accounts/stub`,
    { method: "PUT", headers: { Authorization: `Bearer ${operator}` } },
  );
  assert.ok(
    binding.ok,
    "Bind the isolated synthetic account, not a user's account",
  );
  await new Promise<void>((r) => server.listen(workPort, "127.0.0.1", r));
  const cookies: string[] = [],
    csrf: string[] = [];
  for (const token of tokens) {
    const r = await fetch(origin + "/api/identity/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    cookies.push(cookie);
    const boot = await (
      await fetch(origin + "/api/platform/bootstrap", {
        headers: { Cookie: cookie },
      })
    ).json();
    csrf.push(boot.csrfToken);
  }
  const send = async (person: number, projectId: string, text: string) => {
    const r = await fetch(origin + "/api/platform/messages", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookies[person]!,
        "X-Morphz-Token": csrf[person]!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: text,
          targetActantId: "morphz-agent",
        },
      }),
    });
    const value = await r.json();
    assert.equal(r.status, 202, JSON.stringify(value));
    return value.entityId as string;
  };
  const history = (person: number, projectId: string) =>
    bridge.platformConversationHistory(
      { projectId, conversationId: projectId },
      people[person]!,
    );
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      await bridge.tick();
      const d = (
        store.runtimeState() as {
          deliveries: Array<{
            inputId: string;
            state: string;
            error: string | null;
          }>;
        }
      ).deliveries.find((d) => d.inputId === id);
      if (d?.state === "completed") return;
      assert.notEqual(d?.state, "failed", d?.error ?? "");
      await delay(100);
    }
    assert.fail("处理未完成：" + JSON.stringify(bridge.platformStatus()));
  };
  const a = await send(0, projects[0]!, "ALPHA_PRIVATE_MARKER");
  await settle(a);
  const b = await send(1, projects[1]!, "BETA_PRIVATE_MARKER");
  await settle(b);
  for (const [i, marker] of [
    "ALPHA_PRIVATE_MARKER",
    "BETA_PRIVATE_MARKER",
  ].entries()) {
    const object = (
      await domains.work.authority.withSession(
        people[i]!,
        () => {},
        (actor) =>
          domains.work.service.listContent(actor, {
            projectId: projects[i],
            query: marker,
          }),
      )
    ).find((entry) => entry.title === marker);
    assert.ok(object, "已认证成员的 Host 工具应实际创建对象");
    assert.equal(object.projectId, projects[i]);
    const version = await domains.content.authority.withSession(
      people[i]!,
      () => {},
      (actor) =>
        domains.content.objects.readDocument({
          credential: actor.credential,
          objectId: object.appObjectId,
        }),
    );
    assert.equal(version.author.actantId, "morphz-agent");
    const other = await (
      await fetch(origin + "/api/platform/projects", {
        headers: { Cookie: cookies[1 - i]! },
      })
    ).json();
    assert.ok(
      !other.some((project: { id: string }) => project.id === projects[i]),
    );
    const contentURL = origin + `/api/platform/content/${object.id}`;
    const readable = await fetch(contentURL, {
      headers: { Cookie: cookies[i]! },
    });
    assert.equal(
      readable.status,
      200,
      "The endpoint must read the owner's actual catalog entry",
    );
    assert.equal((await readable.json()).appObjectId, object.appObjectId);
    const denied = await fetch(contentURL, {
      headers: { Cookie: cookies[1 - i]! },
    });
    // Platform content lookup deliberately masks inaccessible objects as missing.
    // Prove this is the real endpoint, not a 404 from an absent legacy route.
    assert.equal(denied.status, 404);
    const failure = await denied.json();
    assert.equal(failure.code, "not_found");
    assert.ok(!JSON.stringify(failure).includes(marker));
  }
  const sharedA = await send(0, "first-project", "SHARED_ALPHA");
  await settle(sharedA);
  const sharedB = await send(1, "first-project", "SHARED_BETA");
  await settle(sharedB);
  const saved = store.runtimeState() as {
    sessions: Record<string, { id: string; projectId: string }>;
  };
  const sessions = Object.values(saved.sessions);
  assert.equal(sessions.length, 3);
  const header = (i: number) => ({
    Authorization: `Bearer ${gateway}`,
    "X-Morphz-Principal": bridge.principalId(people[i]!.principalId),
  });
  const privateSession = sessions.find((s) => s.projectId === projects[0])!;
  assert.equal(
    (
      await fetch(`${runtimeURL}/api/sessions/${privateSession.id}`, {
        headers: header(1),
      })
    ).status,
    403,
  );
  const privateContext = await fetch(
    `${runtimeURL}/api/sessions/${privateSession.id}/context`,
    { headers: header(0) },
  ).then((r) => r.json());
  assert.ok(
    privateContext.state.frames.some(
      (f: any) =>
        f.id === "test-reading-memory" &&
        f.body.includes("ALPHA_PRIVATE_MARKER_UNDERSTANDING"),
    ),
    "The actual context_tx call must persist a source-linked synthetic understanding",
  );
  for (const [path, status] of [
    [`/api/sessions/${privateSession.id}/context`, 403],
    [`/api/sessions/${privateSession.id}/context/projection`, 403],
    // Frame recall is management-plane-only, not a user gateway endpoint.
    [
      `/api/contexts/${privateContext.context_id}/frames/test-reading-memory/recall`,
      401,
    ],
  ])
    assert.equal(
      (await fetch(runtimeURL + path, { headers: header(1) })).status,
      status,
      "An unauthorized identity must not retrieve the private understanding",
    );
  for (const i of [0, 1]) {
    const shared = sessions.find((s) => s.projectId === "first-project")!;
    const p = await (
      await fetch(`${runtimeURL}/api/sessions/${shared.id}/principal`, {
        headers: header(i),
      })
    ).json();
    assert.equal(p.principal_id, bridge.principalId(people[i]!.principalId));
  }
  assert.ok(
    requests.some(
      (r) => r.includes("SHARED_ALPHA") && r.includes("SHARED_BETA"),
    ),
    "同一项目的两个身份共享上下文",
  );
  for (const r of requests)
    assert.ok(
      !(
        r.includes("ALPHA_PRIVATE_MARKER") && r.includes("BETA_PRIVATE_MARKER")
      ),
      "私有项目不能共用模型上下文",
    );
  await assert.rejects(
    history(1, projects[0]!),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "forbidden",
  );
  await bridge.stop();
  const pending = await send(0, projects[0]!, "REVOKED_MUST_NOT_SEND");
  configuration.members[0]!.enabled = false;
  members[0]!.enabled = false;
  await identity.replaceConfiguration(configuration, members);
  assert.equal(
    (
      await fetch(origin + "/api/platform/bootstrap", {
        headers: { Cookie: cookies[0]! },
      })
    ).status,
    401,
  );
  await domains.unbindRuntime(bound.authority);
  bridge = new RuntimeBridge(store, config, identity);
  bound = domains.bindRuntime(bridge);
  await bridge.tick();
  assert.equal(
    (
      store.runtimeState() as {
        deliveries: Array<{ inputId: string; state: string }>;
      }
    ).deliveries.find((d) => d.inputId === pending)?.state,
    "failed",
  );
  assert.ok(!requests.some((r) => r.includes("REVOKED_MUST_NOT_SEND")));
  await bridge.stop();
  await domains.unbindRuntime(bound.authority);
  bridge = new RuntimeBridge(store, config, identity);
  bound = domains.bindRuntime(bridge);
  assert.ok(
    (await history(1, projects[1]!)).runtime.deliveries.some(
      (d) => d.inputId === b && d.state === "completed",
    ),
  );
  const database = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets')",
        )
        .all(),
      [],
    );
  } finally {
    database.close();
  }
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify(
      {
        passed: true,
        runtime: "real",
        provider: "local deterministic",
        principals: 2,
        projectContexts: 3,
        sharedSession: true,
        revocation: true,
        agentObjectWrites: 2,
        privateMindFrames: 2,
        crossIdentityMemoryDenied: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: 真实 Runtime 双身份、共享会话、私有上下文隔离、撤销及重启。",
    directory,
  );
} finally {
  await bridge.stop();
  await domains.unbindRuntime(bound.authority);
  await new Promise<void>((r) => server.close(() => r()));
  server.closeAllConnections();
  runtime.kill("SIGTERM");
  await new Promise<void>((r) =>
    runtime.exitCode !== null ? r() : runtime.once("exit", () => r()),
  );
  await new Promise<void>((r) => provider.close(() => r()));
  await domains.close();
  store.close();
}
import "./application-configuration.mjs";
