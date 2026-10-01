/** Isolated real Runtime + Host Profile control-plane acceptance. No user DB,
 * environment credentials, Session input, model inference or paid provider. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimeBinaryPath } from "./runtime-path.mjs";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { hostOperations } from "../packages/application/src/agent-tools.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  defaultAgentProfile,
  profileRom,
  profileSnapshotSchema,
  profileUpdateResultSchema,
} from "../packages/core/src/profile.js";
import { localAccess } from "../packages/core/src/model.js";

const root = mkdtempSync(join(tmpdir(), "morphz-profile-runtime-")),
  runtimeRoot = join(root, "runtime"),
  runtimeDatabase = join(runtimeRoot, "runtime.sqlite"),
  operator = randomBytes(32).toString("hex"),
  gateway = randomBytes(32).toString("hex");
mkdirSync(runtimeRoot, { mode: 0o700 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
const runtimePort = await freePort(),
  hostPort = await freePort(),
  runtimeUrl = `http://127.0.0.1:${runtimePort}`;
let modelRequests = 0;
const forbiddenProvider = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(503).end("Profile smoke never invokes models");
});
await new Promise<void>((resolve) =>
  forbiddenProvider.listen(0, "127.0.0.1", resolve),
);
const providerPort = (forbiddenProvider.address() as { port: number }).port;
const configuration = join(runtimeRoot, "morphz.toml");
writeFileSync(
  configuration,
  `[llm]\nmodel="profile-smoke"\n[accounts.stub]\nauth_adapter="credential"\ncredential_ref="stub"\nprovider="stub"\n[services.stub]\nadapter="protocol-compatible"\nprotocol="openai-chat"\nbase_url="http://127.0.0.1:${providerPort}/v1"\naccounts=["stub"]\n[[models.profile-smoke.targets]]\nservice="stub"\naccount="stub"\nphysical_model="profile-smoke"\n[credentials.stub]\nsource="env"\nname="PROFILE_SMOKE_KEY"\n[permissions]\nworkspace_root=${JSON.stringify(runtimeRoot)}\n[server.identity]\nmode="trusted-gateway"\nprovider_id="profile-smoke"\nservice_token_env="PROFILE_SMOKE_GATEWAY"\n`,
  { mode: 0o600 },
);
let processHandle: ChildProcess | undefined,
  logs = "";
async function launch() {
  processHandle = spawn(
    runtimeBinaryPath(),
    [
      "serve",
      "--bind",
      `127.0.0.1:${runtimePort}`,
      "--cwd",
      runtimeRoot,
      "--config-file",
      configuration,
      "--log-level",
      "warn",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        MORPHZ_HOME: runtimeRoot,
        MORPHZ_STORAGE_SQLITE_PATH: runtimeDatabase,
        MORPHZ_DASHBOARD_TOKEN: operator,
        PROFILE_SMOKE_GATEWAY: gateway,
        PROFILE_SMOKE_KEY: "unused-synthetic",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [processHandle.stdout, processHandle.stderr])
    stream!.on("data", (bytes) => {
      logs = (logs + bytes.toString()).slice(-8000);
    });
  let launchError: Error | undefined;
  processHandle.once("error", (error) => {
    launchError = error;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    assert.equal(
      processHandle.exitCode,
      null,
      "Isolated Runtime exited: " + logs,
    );
    try {
      if ((await fetch(runtimeUrl + "/health")).ok) return;
    } catch {
      /* bounded startup */
    }
    await pause(100);
  }
  throw new Error("Isolated Runtime did not become ready: " + logs);
}
async function stop() {
  const current = processHandle;
  if (!current || current.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    current.once("exit", () => resolve()),
  );
  current.kill("SIGTERM");
  const deadline = setTimeout(() => current.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(deadline);
  processHandle = undefined;
}
function count(table: "sessions" | "agent_rom_heads") {
  const database = new DatabaseSync(runtimeDatabase, { readOnly: true });
  try {
    return Number(
      (
        database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    );
  } finally {
    database.close();
  }
}
async function getRom(
  agentId: string,
  subject: "human" | "agent",
  scope?: string,
) {
  const response = await fetch(
    `${runtimeUrl}/api/agents/${encodeURIComponent(agentId)}/rom/${profileRom[subject].namespace}${scope ? "?principal_scope=" + encodeURIComponent(scope) : ""}`,
    { headers: { Authorization: "Bearer " + operator } },
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      key: { principal_scope?: string };
      revision: number;
    },
  };
}
const localRoot = join(root, "local"),
  teamRoot = join(root, "team");
mkdirSync(localRoot, { mode: 0o700 });
mkdirSync(teamRoot, { mode: 0o700 });
const localStore = new WorkspaceStore(join(localRoot, "workspace.sqlite"), {
    mode: "transport",
  }),
  teamStore = new WorkspaceStore(join(teamRoot, "workspace.sqlite"), {
    mode: "transport",
  });
const people = [
    { principalId: "alice", actantId: "alice-human" },
    { principalId: "bob", actantId: "bob-human" },
  ],
  loginTokens = people.map(() => randomBytes(32).toString("hex")),
  namespace = randomUUID();
const identity = new IdentityCenter(
  teamStore,
  {
    version: 1,
    members: people.map((person, index) => ({
      ...person,
      enabled: true,
      loginTokenHash: createHash("sha256")
        .update(loginTokens[index]!)
        .digest("hex"),
    })),
  },
  Date.now,
  people.map((person, index) => ({
    ...person,
    name: ["Alice 原名", "Bob 原名"][index],
    enabled: true,
    projectIds: [],
  })),
);
let localDomains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined,
  teamDomains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined,
  server: ReturnType<typeof createAppServer> | undefined,
  localConnection: LocalApplicationConnection | undefined;
const teamConnections: LocalApplicationConnection[] = [];
try {
  await launch();
  assert.equal(count("sessions"), 0);
  const localBridge = new RuntimeBridge(localStore, {
    url: runtimeUrl,
    token: operator,
    namespace: randomUUID(),
  });
  localDomains = await openApplicationDomainsHost(localRoot, localStore);
  localDomains.bindRuntime(localBridge);
  await localBridge.profiles.read(localAccess); // Do not hide a real bridge error behind the UI unavailable state.
  localConnection = new LocalApplicationConnection(
    new Application(localStore, { profiles: localDomains.profiles }),
  );
  const boot = (await localConnection.call("platform.bootstrap")) as {
      csrfToken: string;
    },
    localOptions = { identityGeneration: boot.csrfToken };
  const initial = profileSnapshotSchema.parse(
    await localConnection.call("profile.read", {}, localOptions),
  );
  assert.equal(initial.agent.available, true);
  assert.equal(initial.agent.revision, 0);
  const agentCommand = {
    subject: "agent" as const,
    commandId: randomUUID(),
    expectedRevision: 0,
    data: {
      ...defaultAgentProfile,
      name: "小芷",
      speechStyle: "thoughtful" as const,
    },
  };
  const agentSaved = profileUpdateResultSchema.parse(
    await localConnection.call("profile.update", agentCommand, localOptions),
  );
  assert.equal(agentSaved.revision, 1);
  assert.equal(agentSaved.data.name, "小芷");
  assert.deepEqual(
    await localConnection.call("profile.update", agentCommand, localOptions),
    agentSaved,
  );
  server = createAppServer(localStore, {
    port: hostPort,
    webRoot: "/nonexistent",
    profiles: localDomains.profiles,
  });
  await new Promise<void>((resolve) =>
    server!.listen(hostPort, "127.0.0.1", resolve),
  );
  const http = new HttpApplicationClient(`http://127.0.0.1:${hostPort}`),
    httpBoot = (await http.call("platform.bootstrap")) as { csrfToken: string },
    httpOptions = { identityGeneration: httpBoot.csrfToken };
  const humanCommand = {
    subject: "human" as const,
    commandId: randomUUID(),
    expectedRevision: 0,
    data: { name: "谢先生", preferredAddress: "老谢" },
  };
  const humanSaved = profileUpdateResultSchema.parse(
    await http.call("profile.update", humanCommand, httpOptions),
  );
  assert.equal(humanSaved.revision, 1);
  assert.equal(
    profileSnapshotSchema.parse(
      await http.call("profile.read", {}, httpOptions),
    ).human.data.preferredAddress,
    "老谢",
  );
  const defaultPrincipal = (await localBridge.profiles.identity(localAccess))
    .principalId;
  assert.equal(
    (await getRom(initial.agent.id, "human", defaultPrincipal)).body.key
      .principal_scope,
    defaultPrincipal,
  );
  assert.equal((await getRom(initial.agent.id, "human")).status, 404);
  await assert.rejects(
    http.call(
      "profile.update",
      { ...humanCommand, commandId: randomUUID() },
      httpOptions,
    ),
    /已更新/,
  );
  const beforeProposal = count("agent_rom_heads");
  assert.throws(() => hostOperations.invoke("profile.update", humanCommand));
  const suggestion = hostOperations.invoke("profile.propose", {
    change: {
      subject: "human",
      expectedRevision: 1,
      data: { name: "建议而已", preferredAddress: "未确认" },
    },
  }) as { profile: unknown };
  const proposal = await localDomains.profiles.authority.withSession(
    localAccess,
    () => {},
    (actor) =>
      localDomains!.profiles.service.agentOperation(actor, suggestion.profile),
  );
  assert.equal((proposal as { saved: boolean }).saved, false);
  assert.equal(
    (proposal as { code: string }).code,
    "requires_human_confirmation",
  );
  assert.equal(count("agent_rom_heads"), beforeProposal);

  // Existing Team gateway remains insufficient for ROM administration.
  const teamConfig = {
    url: runtimeUrl,
    token: gateway,
    namespace,
    identityMode: "trusted_gateway" as const,
  };
  const teamBridge = new RuntimeBridge(teamStore, teamConfig, identity);
  teamDomains = await openApplicationDomainsHost(teamRoot, teamStore, identity);
  teamDomains.bindRuntime(teamBridge);
  const unavailable = await teamDomains.profiles.authority.withSession(
    people[0]!,
    () => {},
    (actor) => teamDomains!.profiles.service.read(actor),
  );
  assert.equal(unavailable.human.available, false);
  assert.equal(unavailable.human.data.name, "Alice 原名");
  teamBridge.updateConnection({ ...teamConfig, operatorToken: operator });
  for (const token of loginTokens) {
    const connection = new LocalApplicationConnection(
      new Application(teamStore, { identity, profiles: teamDomains.profiles }),
    );
    await connection.call("login", { token });
    teamConnections.push(connection);
  }
  const teamOptions: Array<{ identityGeneration: string }> = [];
  for (const connection of teamConnections)
    teamOptions.push({
      identityGeneration: (
        (await connection.call("platform.bootstrap")) as { csrfToken: string }
      ).csrfToken,
    });
  const aliceSaved = profileUpdateResultSchema.parse(
    await teamConnections[0]!.call(
      "profile.update",
      {
        ...humanCommand,
        commandId: randomUUID(),
        data: { name: "Alice", preferredAddress: "阿丽" },
      },
      teamOptions[0],
    ),
  );
  assert.equal(aliceSaved.revision, 1);
  const aliceRead = profileSnapshotSchema.parse(
    await teamConnections[0]!.call("profile.read", {}, teamOptions[0]),
  );
  const bobRead = profileSnapshotSchema.parse(
    await teamConnections[1]!.call("profile.read", {}, teamOptions[1]),
  );
  assert.equal(aliceRead.human.data.preferredAddress, "阿丽");
  assert.equal(bobRead.human.revision, 0);
  assert.equal(bobRead.human.data.name, "Bob 原名");
  assert.equal(aliceRead.agent.editable, false);
  await assert.rejects(
    teamConnections[0]!.call(
      "profile.update",
      { ...agentCommand, commandId: randomUUID(), expectedRevision: 1 },
      teamOptions[0],
    ),
    /只读/,
  );
  const alicePrincipal = teamBridge.principalId("alice"),
    bobPrincipal = teamBridge.principalId("bob");
  assert.notEqual(alicePrincipal, bobPrincipal);
  assert.equal(
    (await getRom(initial.agent.id, "human", alicePrincipal)).body.key
      .principal_scope,
    alicePrincipal,
  );
  assert.equal(
    (await getRom(initial.agent.id, "human", bobPrincipal)).status,
    404,
  );
  const gatewayRom = await fetch(
    `${runtimeUrl}/api/agents/${initial.agent.id}/rom`,
    {
      headers: {
        Authorization: "Bearer " + gateway,
        "X-Morphz-Principal": alicePrincipal,
      },
    },
  );
  assert.equal(gatewayRom.status, 401);
  assert.equal(count("sessions"), 0);
  await stop();
  await launch();
  const afterRestart = profileSnapshotSchema.parse(
    await http.call("profile.read", {}, httpOptions),
  );
  assert.equal(afterRestart.agent.data.name, "小芷");
  assert.equal(afterRestart.agent.revision, agentSaved.revision);
  assert.equal(afterRestart.human.data.preferredAddress, "老谢");
  assert.equal(afterRestart.human.revision, humanSaved.revision);
  assert.equal(
    profileSnapshotSchema.parse(
      await teamConnections[0]!.call("profile.read", {}, teamOptions[0]),
    ).human.data.preferredAddress,
    "阿丽",
  );
  assert.deepEqual(
    await localConnection.call("profile.update", agentCommand, localOptions),
    agentSaved,
  );
  assert.equal(count("sessions"), 0);
  assert.equal(modelRequests, 0);
  console.log(
    JSON.stringify({
      ok: true,
      realRuntime: true,
      localEmbeddedAndHttp: true,
      restartRevisionsPreserved: true,
      teamDualCredentialIsolation: true,
      absentTeamOperatorUnavailable: true,
      unconfirmedProposalSaved: false,
      agentDirectWriteRegistered: false,
      sessionsCreated: 0,
      modelRequests: 0,
    }),
  );
} finally {
  localConnection?.close();
  for (const connection of teamConnections) connection.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await localDomains?.close();
  await teamDomains?.close();
  localStore.close();
  teamStore.close();
  await stop();
  await new Promise<void>((resolve) =>
    forbiddenProvider.close(() => resolve()),
  );
  rmSync(root, { recursive: true, force: true });
}
