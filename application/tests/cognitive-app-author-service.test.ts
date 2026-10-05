import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));
const credential = "isolated_author_test_credential_abcdefghijklmnopqrstuvwxyz";
const credentialHash = createHash("sha256").update(credential).digest("hex");
const actor = {
  tenantId: "tenant",
  principalId: "alice",
  actantId: "human_alice",
  kind: "human",
  source: { kind: "human" },
};
let fixtureRoot: string;
let authorRoot: string;
let sdk: any;
let definition: any;
const children = new Set<ChildProcess>();
function isolatedProcessEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (source[key] !== undefined) env[key] = source[key];
  return env;
}
before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "morphz-packed-author-notes-"));
  const sdkRoot = join(fixtureRoot, "sdk");
  mkdirSync(join(sdkRoot, "src"), { recursive: true });
  for (const file of [
    "package.json",
    "tsconfig.build.json",
    "README.md",
    "LICENSE",
    "src/index.ts",
    "src/protocol.ts",
    "src/domain-wire.ts",
  ])
    copyFileSync(
      join(root, "packages/cognitive-app-sdk", file),
      join(sdkRoot, file),
    );
  const userConfig = join(fixtureRoot, "npm-user.cfg"),
    globalConfig = join(fixtureRoot, "npm-global.cfg");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "formal npm test supplies its actual npm CLI");
  const npm = (cwd: string, args: string[]) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...isolatedProcessEnvironment(),
        npm_config_cache: join(homedir(), ".npm"),
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_registry: "https://registry.npmjs.org/",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    });
  npm(sdkRoot, [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  const packed = JSON.parse(
    npm(sdkRoot, ["pack", "--offline", "--json", "--silent"]),
  );
  authorRoot = join(fixtureRoot, "author");
  mkdirSync(authorRoot);
  for (const file of [
    "package.json",
    "service.mjs",
    "definition.json",
    "README.md",
    "MODEL.md",
  ])
    copyFileSync(
      join(root, "examples/cognitive-notes", file),
      join(authorRoot, file),
    );
  npm(authorRoot, [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(sdkRoot, packed[0].filename),
  ]);
  const entry = join(authorRoot, "public-consumer.mjs");
  writeFileSync(entry, 'export * from "@morphz/cognitive-app-sdk";\n');
  return import(pathToFileURL(entry).href).then((module) => {
    sdk = module;
    definition = sdk.parseCognitiveAppDefinition(
      JSON.parse(readFileSync(join(authorRoot, "definition.json"), "utf8")),
    );
  });
});
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  children.delete(child);
}
after(async () => {
  for (const child of children) await stop(child);
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});
async function start(db: string, config: string) {
  const child = spawn(
    process.execPath,
    [
      join(authorRoot, "service.mjs"),
      "--db",
      db,
      "--config",
      config,
      "--port",
      "0",
    ],
    {
      cwd: authorRoot,
      env: isolatedProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  const ready = await new Promise<any>((resolve, reject) => {
    let lines = "",
      stderr = "";
    const timer = setTimeout(
      () => reject(new Error("isolated author startup timeout")),
      10000,
    );
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout!.on("data", (chunk) => {
      lines += String(chunk);
      if (lines.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(lines.split("\n")[0]!));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`author exited ${code}: ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, ready, origin: `http://127.0.0.1:${ready.port}` };
}
async function isolated(work: (value: any) => Promise<void>) {
  const directory = mkdtempSync(join(fixtureRoot, "data-"));
  const db = join(directory, "author.sqlite"),
    config = join(directory, "bootstrap.json");
  writeFileSync(
    config,
    JSON.stringify({
      format: "cognitive-notes-bootstrap/v1",
      integrations: [
        {
          credentialSha256: credentialHash,
          issuer: "trusted_host",
          tenantId: "tenant",
          principalId: "alice",
          humanActantId: "human_alice",
          agentActantIds: ["agent"],
          projects: [
            { projectId: "project_one", read: true, write: true },
            { projectId: "project_two", read: true, write: true },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  let process = await start(db, config);
  const authority = {
    ...process.ready.definition,
    instanceId: "host_instance",
    serviceId: process.ready.serviceId,
    dataAuthorityId: process.ready.dataAuthorityId,
  };
  const context = {
    db,
    config,
    authority,
    get origin() {
      return process.origin;
    },
    get child() {
      return process.child;
    },
    async restart() {
      await stop(process.child);
      process = await start(db, config);
      return process.ready;
    },
    rows(sql: string, values: any[] = []) {
      const connection = new DatabaseSync(db);
      try {
        return connection.prepare(sql).all(...values);
      } finally {
        connection.close();
      }
    },
    change(sql: string, values: any[] = []) {
      const connection = new DatabaseSync(db);
      try {
        return connection.prepare(sql).run(...values);
      } finally {
        connection.close();
      }
    },
  };
  try {
    await work(context);
  } finally {
    await stop(process.child);
  }
}
async function post(
  origin: string,
  path: string,
  body: unknown,
  token = credential,
) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    body: JSON.parse(bytes.toString("utf8")),
    bytes,
  };
}
function invocation(
  authority: any,
  commandId: string | null,
  operationId = "notes.create",
  parameters: any = { title: "Original", markdown: "author original" },
  resources: any[] = [],
  actualActor: any = actor,
  projectId = "project_one",
) {
  const operation = definition.operations.find(
    (item: any) => item.id === operationId,
  );
  const request = {
    protocol: "morphz-domain/v1",
    delegation: {
      issuer: "trusted_host",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      purpose: "invoke",
      authority,
      actor: actualActor,
      projectId,
      operationId,
      resources,
      command:
        commandId === null ? null : { commandId, requestHash: "0".repeat(64) },
    },
    parameters,
  };
  if (request.delegation.command)
    request.delegation.command.requestHash = createHash("sha256")
      .update(
        sdk.canonicalInvokeIdentityBytes(
          request,
          operation.effect,
          operation.scope,
        ),
      )
      .digest("hex");
  return request;
}
function recovery(request: any) {
  const d = request.delegation;
  return {
    protocol: request.protocol,
    delegation: {
      issuer: d.issuer,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      purpose: "receipt-recovery",
      authority: d.authority,
      actor: d.actor,
      projectId: d.projectId,
      originalOperationId: d.operationId,
      originalResources: d.resources,
      historicalAdmission: d.command,
    },
  };
}
function exactRead(request: any, object: any, maxBytes = 262144) {
  const d = request.delegation;
  const reference = {
    objectId: object.objectId,
    versionRef: object.versionRef,
  };
  return {
    protocol: request.protocol,
    delegation: {
      issuer: d.issuer,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      purpose: "object-read",
      authority: d.authority,
      actor: d.actor,
      projectId: d.projectId,
      resource: reference,
    },
    object: reference,
    maxBytes,
  };
}

test("author notes service imports the packed public SDK, not Host implementation", () => {
  const sentinel = "MORPHZ_AUTHOR_ENV_ISOLATION_SENTINEL";
  const isolatedEnv = isolatedProcessEnvironment({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    [sentinel]: "must-not-cross-process-boundary",
    PGPASSWORD: "isolated-test-value",
    NODE_OPTIONS: "--throw-deprecation",
  });
  const observed = execFileSync(
    process.execPath,
    [
      "-e",
      `console.log(JSON.stringify(${JSON.stringify([sentinel, "PGPASSWORD", "NODE_OPTIONS"])}.map(key=>Object.hasOwn(process.env,key))))`,
    ],
    { env: isolatedEnv, encoding: "utf8", timeout: 10000 },
  );
  assert.deepEqual(JSON.parse(observed), [false, false, false]);
  const source = readFileSync(
    new URL("../examples/cognitive-notes/service.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "@morphz\/cognitive-app-sdk"/);
  assert.doesNotMatch(
    source,
    /(?:packages\/(?:application|platform|core)|WorkspaceClient|CognitiveAppGateway)/,
  );
});

test("packed author runs headless and persists immutable originals and actual same receipt across restart", async () => {
  await isolated(async (c) => {
    const described = await post(c.origin, "/describe", {
      protocol: "morphz-domain/v1",
      definition: c.authority.appId
        ? {
            appId: c.authority.appId,
            version: c.authority.version,
            definitionHash: c.authority.definitionHash,
          }
        : null,
    });
    assert.equal(described.status, 200);
    assert.equal(described.body.dataAuthorityId, c.authority.dataAuthorityId);
    assert.equal(
      c.authority.definitionHash,
      createHash("sha256")
        .update(sdk.canonicalJsonBytes(definition))
        .digest("hex"),
    );
    assert.equal(definition.ui, null);
    assert.equal(definition.harness, null);
    const request = invocation(c.authority, "create");
    const first = await post(c.origin, "/invoke", request);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "committed");
    sdk.parseDomainReceipt(first.body);
    sdk.validateOperationValue(
      definition.operations[1].outputSchema,
      first.body.result,
    );
    const replay = await post(c.origin, "/invoke", {
      ...request,
      delegation: {
        ...request.delegation,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      },
    });
    assert.deepEqual(replay.bytes, first.bytes);
    assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 1);
    const ready = await c.restart();
    assert.equal(ready.dataAuthorityId, c.authority.dataAuthorityId);
    const recovered = await post(c.origin, "/receipts/read", recovery(request));
    assert.deepEqual(recovered.bytes, first.bytes);
    assert.equal(
      c.rows("SELECT receipt_hash FROM author_commands")[0].receipt_hash,
      createHash("sha256").update(first.bytes).digest("hex"),
    );
    const read = await post(
      c.origin,
      "/objects/read",
      exactRead(request, first.body.objects[0]),
    );
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.content.value, request.parameters);
    const list = await post(
      c.origin,
      "/invoke",
      invocation(c.authority, null, "notes.list", { limit: 1 }),
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.result.objects.length, 1);
  });
});
test("author exact baseline revisions are immutable, cross-project cannot move originals and concurrent same commands do not duplicate", async () => {
  await isolated(async (c) => {
    const firstRequest = invocation(c.authority, "first");
    const concurrent = await Promise.all([
      post(c.origin, "/invoke", firstRequest),
      post(c.origin, "/invoke", firstRequest),
    ]);
    assert.deepEqual(concurrent[0]!.bytes, concurrent[1]!.bytes);
    const original = concurrent[0]!.body.objects[0];
    const parameters = {
      objectId: original.objectId,
      baselineVersionRef: original.versionRef,
      title: "Revised",
      markdown: "second original",
    };
    const revise = invocation(
      c.authority,
      "revise",
      "notes.revise",
      parameters,
      [{ objectId: original.objectId, versionRef: original.versionRef }],
    );
    // Directory summaries contain kind/title; wire resources must be exact refs.
    revise.delegation.resources = [
      { objectId: original.objectId, versionRef: original.versionRef },
    ];
    revise.delegation.command!.requestHash = createHash("sha256")
      .update(sdk.canonicalInvokeIdentityBytes(revise, "write", "objects"))
      .digest("hex");
    const second = await post(c.origin, "/invoke", revise);
    assert.equal(second.body.status, "committed");
    assert.notEqual(second.body.result.versionRef, original.versionRef);
    const old = await post(
      c.origin,
      "/objects/read",
      exactRead(firstRequest, {
        objectId: original.objectId,
        versionRef: original.versionRef,
      }),
    );
    assert.equal(old.body.content.value.markdown, "author original");
    const stale = await post(
      c.origin,
      "/invoke",
      invocation(
        c.authority,
        "stale",
        "notes.revise",
        parameters,
        revise.delegation.resources,
      ),
    );
    assert.equal(stale.body.status, "rejected");
    assert.equal(stale.body.reason.code, "baseline_conflict");
    assert.deepEqual(
      (
        await post(
          c.origin,
          "/receipts/read",
          recovery(
            invocation(
              c.authority,
              "stale",
              "notes.revise",
              parameters,
              revise.delegation.resources,
            ),
          ),
        )
      ).bytes,
      stale.bytes,
    );
    const moved = await post(
      c.origin,
      "/invoke",
      invocation(
        c.authority,
        "move",
        "notes.revise",
        { ...parameters, baselineVersionRef: second.body.result.versionRef },
        [
          {
            objectId: original.objectId,
            versionRef: second.body.result.versionRef,
          },
        ],
        actor,
        "project_two",
      ),
    );
    assert.equal(moved.status, 403);
    assert.equal(
      c.rows("SELECT project_id FROM notes")[0].project_id,
      "project_one",
    );
    assert.equal(c.rows("SELECT count(*) AS n FROM note_versions")[0].n, 2);
    assert.throws(
      () => c.change("UPDATE note_versions SET title='rewritten'"),
      /immutable/,
    );
    const missing = await post(
      c.origin,
      "/objects/read",
      exactRead(firstRequest, {
        objectId: original.objectId,
        versionRef: "not_latest",
      }),
    );
    assert.equal(missing.status, 404);
  });
});
test("author account mapping rejects forged principals/sources/authority/expiry while valid Agent task-run is retained", async () => {
  await isolated(async (c) => {
    const taskActor = {
      ...actor,
      kind: "agent",
      actantId: "agent",
      source: {
        kind: "task-run",
        sessionId: "session",
        scheduleId: "schedule",
        eventId: "event",
        sourceInputId: "input",
        humanActantId: "human_alice",
      },
    };
    const valid = invocation(
      c.authority,
      "task",
      "notes.create",
      { title: "Agent", markdown: "real saved by mapped actor" },
      [],
      taskActor,
    );
    const created = await post(c.origin, "/invoke", valid);
    assert.equal(created.body.status, "committed");
    assert.deepEqual(created.body.binding.actor, taskActor);
    for (const [index, actualActor] of [
      { ...actor, principalId: "bob" },
      { ...actor, tenantId: "other" },
      { ...actor, actantId: "other_human" },
      { ...taskActor, actantId: "unapproved_agent" },
      {
        ...taskActor,
        source: { ...taskActor.source, humanActantId: "other_human" },
      },
    ].entries())
      assert.equal(
        (
          await post(
            c.origin,
            "/invoke",
            invocation(
              c.authority,
              `forged_${index}`,
              "notes.create",
              undefined,
              [],
              actualActor,
            ),
          )
        ).status,
        403,
      );
    for (const key of ["serviceId", "dataAuthorityId"])
      assert.equal(
        (
          await post(
            c.origin,
            "/invoke",
            invocation(
              { ...c.authority, [key]: "another" },
              `authority_${key}`,
            ),
          )
        ).status,
        403,
      );
    const expired = invocation(c.authority, "expired");
    expired.delegation.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal((await post(c.origin, "/invoke", expired)).status, 403);
    const denied = await post(
      c.origin,
      "/invoke",
      valid,
      "wrong_test_credential_abcdefghijklmnopqrstuvwxyz",
    );
    assert.equal(denied.status, 403);
    assert.equal(Object.hasOwn(denied.body, "status"), false);
    assert.deepEqual(
      (await post(c.origin, "/receipts/read", recovery(valid))).bytes,
      created.bytes,
    );
    assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 1);
    c.change("UPDATE integrations SET active=0");
    await c.restart();
    assert.equal(
      (await post(c.origin, "/receipts/read", recovery(valid))).status,
      403,
    );
    assert.equal(c.rows("SELECT count(*) AS n FROM author_commands")[0].n, 1);
  });
});
test("author full semantic hash and fixed recovery binding reject changed inputs without overwriting known fact", async () => {
  await isolated(async (c) => {
    const original = invocation(c.authority, "same");
    const fact = await post(c.origin, "/invoke", original);
    assert.equal(
      (
        await post(c.origin, "/invoke", {
          ...original,
          parameters: { title: "altered", markdown: "new" },
        })
      ).status,
      409,
    );
    const changed = invocation(c.authority, "same", "notes.create", {
      title: "altered",
      markdown: "new",
    });
    assert.equal((await post(c.origin, "/invoke", changed)).status, 409);
    const wrongRecovery = recovery(original);
    wrongRecovery.delegation.authority = {
      ...c.authority,
      instanceId: "another_host_instance",
    };
    assert.equal(
      (await post(c.origin, "/receipts/read", wrongRecovery)).status,
      409,
    );
    assert.deepEqual(
      (await post(c.origin, "/receipts/read", recovery(original))).bytes,
      fact.bytes,
    );
    assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 1);
    const body = "original\u0000body\ud800kept";
    const text = invocation(c.authority, "json_body", "notes.create", {
      title: "合法😀",
      markdown: body,
    });
    const saved = await post(c.origin, "/invoke", text);
    assert.equal(saved.body.result.markdown, body);
    const read = await post(
      c.origin,
      "/objects/read",
      exactRead(text, {
        objectId: saved.body.result.objectId,
        versionRef: saved.body.result.versionRef,
      }),
    );
    assert.equal(read.body.content.value.markdown, body);
    assert.equal(
      (
        await post(
          c.origin,
          "/objects/read",
          exactRead(
            text,
            {
              objectId: saved.body.result.objectId,
              versionRef: saved.body.result.versionRef,
            },
            1,
          ),
        )
      ).status,
      400,
    );
  });
});
test("author not_seen stays unknown while an earlier real body can still arrive and commit", async () => {
  await isolated(async (c) => {
    const request = invocation(c.authority, "in_flight");
    const bytes = Buffer.from(JSON.stringify(request));
    const pending = new Promise<any>((resolve, reject) => {
      const connection = httpRequest(
        `${c.origin}/invoke`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json",
            "Content-Length": bytes.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
          );
        },
      );
      connection.on("error", reject);
      connection.setTimeout(15000, () =>
        connection.destroy(new Error("isolated author HTTP timeout")),
      );
      connection.write(bytes.subarray(0, 1));
      void post(c.origin, "/receipts/read", recovery(request))
        .then((response) => {
          assert.equal(response.body.status, "unknown");
          assert.equal(response.body.reason.code, "not_seen");
          assert.equal(Object.hasOwn(response.body, "receiptId"), false);
          connection.end(bytes.subarray(1));
        })
        .catch((error) => {
          connection.destroy();
          reject(error);
        });
    });
    const committed = await pending;
    assert.equal(committed.status, "committed");
    assert.deepEqual(
      (await post(c.origin, "/receipts/read", recovery(request))).body,
      committed,
    );
  });
});
test("author real post-COMMIT lost response and process restart recover exactly the original receipt", async () => {
  await isolated(async (c) => {
    const proxyFile = join(fixtureRoot, "drop-after-real-response.mjs");
    writeFileSync(
      proxyFile,
      `import http from 'node:http'; import {createHash} from 'node:crypto'; const server=http.createServer((req,res)=>{const upstream=http.request(process.argv[2]+req.url,{method:req.method,headers:req.headers},reply=>{const chunks=[];reply.on('data',c=>chunks.push(c));reply.on('end',()=>{const b=Buffer.concat(chunks);console.log(JSON.stringify({event:'dropped',status:reply.statusCode,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}));res.destroy();});});upstream.on('error',()=>res.destroy());req.pipe(upstream);});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({event:'ready',port:server.address().port})));process.on('SIGTERM',()=>{server.close(()=>process.exit(0));server.closeAllConnections();});`,
    );
    const proxy = spawn(process.execPath, [proxyFile, c.origin], {
      env: isolatedProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(proxy);
    const messages = new Map<string, any>();
    const waiting = new Map<
      string,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let proxyFailure: Error | null = null;
    const failProxy = (error: Error) => {
      proxyFailure = error;
      for (const waiter of waiting.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiting.clear();
    };
    const waitMessage = (event: string) => {
      if (messages.has(event)) return Promise.resolve(messages.get(event));
      if (proxyFailure) return Promise.reject(proxyFailure);
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(event);
          reject(new Error(`isolated loss proxy ${event} timeout`));
        }, 10000);
        waiting.set(event, { resolve, reject, timer });
      });
    };
    proxy.once("error", failProxy);
    proxy.once("exit", (code) =>
      failProxy(new Error(`isolated loss proxy exited ${code}`)),
    );
    let lines = "";
    proxy.stdout!.on("data", (chunk) => {
      lines += String(chunk);
      while (lines.includes("\n")) {
        const index = lines.indexOf("\n");
        const row = JSON.parse(lines.slice(0, index));
        lines = lines.slice(index + 1);
        messages.set(row.event, row);
        const waiter = waiting.get(row.event);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiting.delete(row.event);
          waiter.resolve(row);
        }
      }
    });
    try {
      const entry = await waitMessage("ready");
      const request = invocation(c.authority, "lost");
      await assert.rejects(
        post(`http://127.0.0.1:${entry.port}`, "/invoke", request),
      );
      const witness = await waitMessage("dropped");
      assert.equal(witness.status, 200);
      assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 1);
      await c.restart();
      const fact = await post(c.origin, "/receipts/read", recovery(request));
      assert.equal(fact.body.status, "committed");
      assert.equal(
        createHash("sha256").update(fact.bytes).digest("hex"),
        witness.sha256,
      );
      assert.equal(fact.bytes.length, witness.bytes);
      assert.deepEqual(
        (await post(c.origin, "/invoke", request)).bytes,
        fact.bytes,
      );
      assert.equal(c.rows("SELECT count(*) AS n FROM note_versions")[0].n, 1);
    } finally {
      await stop(proxy);
    }
  });
});

test("author fatal UTF-8, body budgets and strict schemas produce safe errors with zero business effects", async () => {
  await isolated(async (c) => {
    for (const body of [
      Buffer.from([0xff]),
      Buffer.alloc(512 * 1024 + 1, 0x61),
    ]) {
      const response = await fetch(`${c.origin}/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, body.length === 1 ? 400 : 413);
      const error = await response.text();
      assert.equal(error.includes(credential), false);
      assert.equal(error.includes(c.db), false);
      assert.equal(error.includes("SELECT"), false);
    }
    const valid = invocation(c.authority, "strict");
    for (const contentType of [
      "application/json; charset=utf-8",
      'APPLICATION/JSON; CHARSET="UTF-8"',
      "application/json ; charset = utf-8",
    ]) {
      const utf8 = await fetch(`${c.origin}/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": contentType,
        },
        body: JSON.stringify(
          invocation(c.authority, null, "notes.list", { limit: 1 }),
        ),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(utf8.status, 200, "accept UTF-8 JSON from the actual Host");
      await utf8.arrayBuffer();
    }
    for (const contentType of [
      "text/plain",
      "application/json; charset=iso-8859-1",
      "application/json; charset=utf-8; charset=utf-8",
      "application/json; profile=other",
    ]) {
      const rejectedMedia = await fetch(`${c.origin}/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": contentType,
        },
        body: JSON.stringify(valid),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(rejectedMedia.status, 415);
      await rejectedMedia.arrayBuffer();
    }
    assert.equal(
      (
        await post(c.origin, "/invoke", {
          ...valid,
          endpoint: "https://not-authority.invalid/",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(c.origin, "/invoke", {
          ...valid,
          parameters: { ...valid.parameters, principalId: "bob" },
        })
      ).status,
      400,
    );
    const invalidTitle = invocation(c.authority, "bad_title", "notes.create", {
      title: "unsafe\u0000metadata",
      markdown: "still no write",
    });
    const rejected = await post(c.origin, "/invoke", invalidTitle);
    assert.equal(rejected.body.status, "rejected");
    assert.equal(rejected.body.reason.code, "invalid_title");
    assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 0);
    assert.equal(c.rows("SELECT count(*) AS n FROM author_commands")[0].n, 1);
    assert.deepEqual(
      (await post(c.origin, "/receipts/read", recovery(invalidTitle))).bytes,
      rejected.bytes,
    );
  });
});
test("author transaction rechecks account and project revocation after genuine HTTP header acceptance", async () => {
  await isolated(async (c) => {
    for (const [index, revoke] of [
      "UPDATE integrations SET active=0",
      "UPDATE project_acl SET can_write=0",
    ].entries()) {
      c.change("UPDATE integrations SET active=1");
      c.change("UPDATE project_acl SET can_write=1");
      const wire = invocation(c.authority, `revoked_${index}`),
        bytes = Buffer.from(JSON.stringify(wire));
      const response = await new Promise<any>((resolve, reject) => {
        const request = httpRequest(
          `${c.origin}/invoke`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credential}`,
              "Content-Type": "application/json",
              "Content-Length": bytes.length,
              Expect: "100-continue",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
          },
        );
        request.on("error", reject);
        request.setTimeout(15000, () =>
          request.destroy(new Error("isolated author HTTP timeout")),
        );
        request.once("continue", () => {
          c.change(revoke);
          request.end(bytes);
        });
        request.flushHeaders();
      });
      assert.equal(response.status, 403);
      assert.equal(Object.hasOwn(response.body, "status"), false);
    }
    assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 0);
    assert.equal(c.rows("SELECT count(*) AS n FROM author_commands")[0].n, 0);
  });
});
test("author data authority is new per database and DB-injected definitions never become executable support", async () => {
  await isolated(async (c) => {
    const emptyV1 = join(fixtureRoot, "damaged-empty-v1.sqlite");
    const damaged = new DatabaseSync(emptyV1);
    damaged.exec("PRAGMA user_version=1");
    damaged.close();
    await assert.rejects(start(emptyV1, c.config), /author exited 1/);
    const preserved = new DatabaseSync(emptyV1);
    try {
      assert.equal(
        preserved.prepare("PRAGMA user_version").get()!.user_version,
        1,
      );
      assert.equal(
        preserved
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get()!.n,
        0,
      );
    } finally {
      preserved.close();
    }
    const unsupported = sdk.parseCognitiveAppDefinition({
      ...definition,
      version: "1.0.1",
    });
    const digest = createHash("sha256")
      .update(sdk.canonicalJsonBytes(unsupported))
      .digest("hex");
    c.change("INSERT INTO author_definitions VALUES(?,?,?)", [
      unsupported.version,
      digest,
      Buffer.from(sdk.canonicalJsonBytes(unsupported)).toString("utf8"),
    ]);
    await c.restart();
    const request = invocation(
      { ...c.authority, version: unsupported.version, definitionHash: digest },
      "not_code_support",
    );
    assert.equal((await post(c.origin, "/invoke", request)).status, 409);
    assert.equal(c.rows("SELECT count(*) AS n FROM notes")[0].n, 0);
    await isolated(async (other) => {
      assert.notEqual(
        other.authority.dataAuthorityId,
        c.authority.dataAuthorityId,
      );
      assert.equal(other.authority.serviceId, c.authority.serviceId);
    });
    assert.throws(
      () =>
        c.change(
          "UPDATE author_definitions SET definition_hash=? WHERE version=?",
          ["f".repeat(64), definition.version],
        ),
      /immutable/,
    );
  });
});
