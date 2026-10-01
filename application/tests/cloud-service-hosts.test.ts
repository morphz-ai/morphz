import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startService(
  directory: string,
  port: number,
  tenantId: string,
  schemas: {
    platform: string;
    objects: string;
    script: string;
    reader: string;
    browser: string;
  },
  deploymentId: string,
) {
  // A cloud Host has a private delivery database. Only Platform and the
  // Cognitive App domains below are shared; no local database is copied.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("MORPHZ_APP_") && !key.startsWith("MORPHZWORK_"),
    ),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../apps/service/src/main.ts", import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...env,
        MORPHZ_APP_ENV_FILE: "",
        MORPHZ_APP_DATA_DIR: directory,
        MORPHZ_APP_PORT: String(port),
        MORPHZ_APP_TENANT_ID: tenantId,
        MORPHZ_APP_PLATFORM_POSTGRES_URL: connectionString!,
        MORPHZ_APP_PLATFORM_POSTGRES_SCHEMA: schemas.platform,
        MORPHZ_APP_OBJECTS_POSTGRES_URL: connectionString!,
        MORPHZ_APP_SCRIPT_POSTGRES_URL: connectionString!,
        MORPHZ_APP_READER_POSTGRES_URL: connectionString!,
        MORPHZ_APP_BROWSER_POSTGRES_URL: connectionString!,
        MORPHZ_APP_COGNITIVE_DEPLOYMENT_ID: deploymentId,
        MORPHZ_APP_OBJECTS_POSTGRES_SCHEMA: schemas.objects,
        MORPHZ_APP_SCRIPT_POSTGRES_SCHEMA: schemas.script,
        MORPHZ_APP_READER_POSTGRES_SCHEMA: schemas.reader,
        MORPHZ_APP_BROWSER_POSTGRES_SCHEMA: schemas.browser,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  let readinessError = "尚未请求 HTTP 启动接口";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const failureDetails = () => {
    const diagnostic = `${stderr}\nlast HTTP error: ${readinessError}`
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[PostgreSQL URL]")
      .replace(/((?:password|secret|token))=[^\s]+/gi, "$1=[redacted]");
    return `exit=${child.exitCode}, signal=${child.signalCode}, stderr=${diagnostic}`;
  };
  const client = new HttpApplicationClient(`http://127.0.0.1:${port}`);
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`云端 Service 在 HTTP 就绪前退出：${failureDetails()}`);
      try {
        const boot = (await client.call("platform.bootstrap", undefined, {
          signal: AbortSignal.timeout(1000),
        })) as { centerId: string; csrfToken: string };
        return { child, client, boot };
      } catch (error) {
        readinessError = error instanceof Error ? error.message : String(error);
        await delay(100);
      }
    }
    throw new Error(`云端 Service 未在限定时间内就绪：${failureDetails()}`);
  } catch (error) {
    await stop(child);
    throw error;
  }
}

test(
  "两个真实 Service Host 通过 HTTP 共用云端 Platform 与应用原件，各自保留本机投递库",
  { skip: !connectionString },
  async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const tenantId = randomUUID();
    const deploymentId = `cognitive_${suffix}`;
    const schemas = {
      platform: `p_${suffix}`,
      objects: `o_${suffix}`,
      script: `s_${suffix}`,
      reader: `r_${suffix}`,
      browser: `b_${suffix}`,
    };
    const directoryA = mkdtempSync(join(tmpdir(), "morphz-cloud-service-a-"));
    const directoryB = mkdtempSync(join(tmpdir(), "morphz-cloud-service-b-"));
    const pool = new Pool({ connectionString });
    const children: ChildProcess[] = [];
    try {
      for (const schema of Object.values(schemas))
        await pool.query(`CREATE SCHEMA "${schema}"`);
      const portA = await freePort();
      let portB = await freePort();
      while (portB === portA) portB = await freePort();
      const a = await startService(
        directoryA,
        portA,
        tenantId,
        schemas,
        deploymentId,
      );
      children.push(a.child);
      const b = await startService(
        directoryB,
        portB,
        tenantId,
        schemas,
        deploymentId,
      );
      children.push(b.child);
      assert.equal(a.boot.centerId, tenantId);
      assert.equal(b.boot.centerId, tenantId);
      assert.ok(existsSync(join(directoryA, "workspace.sqlite")));
      assert.ok(existsSync(join(directoryB, "workspace.sqlite")));
      for (const directory of [directoryA, directoryB]) {
        const local = new DatabaseSync(join(directory, "workspace.sqlite"), {
          readOnly: true,
        });
        try {
          const names = new Set(
            (
              local
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all() as { name: string }[]
            ).map((row) => row.name),
          );
          assert.equal(names.has("workspace"), false);
          assert.equal(names.has("assets"), false);
          assert.equal(names.has("commands"), false);
          assert.equal(names.has("runtime_deliveries"), true);
        } finally {
          local.close();
        }
      }
      const optionsA = { identityGeneration: a.boot.csrfToken };
      const optionsB = { identityGeneration: b.boot.csrfToken };
      assert.deepEqual(
        await a.client.call("spaces.ensure", undefined, optionsA),
        await b.client.call("spaces.ensure", undefined, optionsB),
      );
      const projectId = `project_${suffix}`;
      const title = "两个 Service 的同一项目";
      assert.equal(
        await a.client.call(
          "projects.create",
          { commandId: `project_${suffix}`, projectId, title },
          optionsA,
        ),
        projectId,
      );
      assert.equal(
        (
          (await b.client.call("projects.get", { projectId })) as {
            title: string;
          }
        ).title,
        title,
      );
      const document = (await a.client.call(
        "documents.create",
        {
          commandId: randomUUID(),
          objectId: `object_${suffix}`,
          projectId,
          title: "跨 Host 文档",
          markdown: "# 云端原件\nA 写入，B 读取。",
        },
        optionsA,
      )) as { contentId: string };
      assert.equal(
        (
          (await b.client.call("documents.read", {
            contentId: document.contentId,
          })) as { markdown: string }
        ).markdown,
        "# 云端原件\nA 写入，B 读取。",
      );
      const script = (await b.client.call(
        "scripts.create",
        {
          commandId: randomUUID(),
          productionId: `production_${suffix}`,
          projectId,
          title: "跨 Host 剧本",
        },
        optionsB,
      )) as { contentId: string };
      assert.equal(
        (
          (await a.client.call("scripts.read", {
            contentId: script.contentId,
          })) as { title: string }
        ).title,
        "跨 Host 剧本",
      );
    } finally {
      await Promise.all(children.map(stop));
      for (const schema of Object.values(schemas))
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
      rmSync(directoryA, { recursive: true, force: true });
      rmSync(directoryB, { recursive: true, force: true });
    }
  },
);
