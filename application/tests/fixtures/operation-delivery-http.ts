import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { createAppServer } from "../../apps/service/src/http.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./actual-mounted-client-test.js";

export const operationHuman = {
  principalId: "operation-human",
  actantId: "operation-actant",
};
export const otherOperationHuman = {
  principalId: "operation-other",
  actantId: "operation-other-actant",
};
const token = (who: { principalId: string }) =>
  createHash("sha256")
    .update("operation-delivery:" + who.principalId)
    .digest("hex");
export type OperationHttpRead = {
  path: string;
  query: string;
  method: string;
  status: number;
  returnedStatus?: number;
  body: unknown;
  response: unknown;
};
export async function withOperationHttp(
  name: string,
  run: (context: {
    readonly client: ActualMountedClient;
    reads(): Promise<OperationHttpRead[]>;
    rows(): Promise<Record<string, string>>;
    login(other?: boolean): Promise<void>;
    remount(): Promise<void>;
    interceptNext(path: string, status?: number): Promise<void>;
    holdNext(path: string): ReturnType<ActualMountedClient["hold"]>;
    failNextClear(): Promise<void>;
    sql(): {
      objects: Record<string, unknown>[];
      versions: Record<string, unknown>[];
      objectReceipts: Record<string, unknown>[];
      projects: Record<string, unknown>[];
      tasks: Record<string, unknown>[];
      taskVersions: Record<string, unknown>[];
      platformReceipts: Record<string, unknown>[];
      scriptReceipts: Record<string, unknown>[];
    };
  }) => Promise<void>,
) {
  // Mounted React and native browser HTTP/cookies/storage, with real private
  // Application/Identity/Platform/Objects SQLite. Never an SSR business owner.
  const web = await mountedClientWebRoot();
  let fixture: Awaited<ReturnType<typeof agentDomainFixture>>;
  try {
    fixture = await agentDomainFixture({
      additionalHumans: [operationHuman, otherOperationHuman],
      loginTokenForHuman: token,
    });
  } catch (error) {
    web.close();
    throw error;
  }
  const sql = () => {
    const objects = new DatabaseSync(
        join(fixture.directory, "objects.sqlite"),
        { readOnly: true },
      ),
      platform = new DatabaseSync(join(fixture.directory, "platform.sqlite"), {
        readOnly: true,
      }),
      scripts = new DatabaseSync(
        join(fixture.directory, "script-studio.sqlite"),
        { readOnly: true },
      );
    try {
      const all = (db: DatabaseSync, table: string, order: string) =>
        db
          .prepare("SELECT * FROM " + table + " ORDER BY " + order)
          .all() as Record<string, unknown>[];
      return {
        objects: all(objects, "objects", "object_id"),
        versions: all(objects, "object_versions", "object_id,revision"),
        objectReceipts: all(objects, "object_command_receipts", "command_id"),
        projects: all(platform, "projects", "project_id"),
        tasks: all(platform, "tasks", "task_id"),
        taskVersions: all(platform, "task_versions", "task_id,revision"),
        platformReceipts: all(platform, "command_receipts", "command_id"),
        scriptReceipts: all(scripts, "script_command_receipts", "command_id"),
      };
    } finally {
      objects.close();
      platform.close();
      scripts.close();
    }
  };

  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  const login = async (other = false) => {
    assert(client);
    if (await client.snapshot()) await client.call("logout");
    const human = other ? otherOperationHuman : operationHuman;
    await client.call("login", [token(human)]);
    await client.waitReady(human.principalId);
  };
  try {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421);
    server = createAppServer(fixture.transport, {
      identity: fixture.identity,
      platformWork: fixture.domains.work,
      platformDocuments: fixture.domains.content,
      platformScripts: fixture.domains.content,
      platformReader: fixture.domains.reader,
      bookmarkDomain: fixture.domains.browser,
      messageAttachments: fixture.domains.messageAttachments,
      uiPackages: fixture.domains.uiPackages,
      notifications: fixture.domains.notifications,
      cognitiveApps: fixture.domains.cognitiveApps,
      workspaceChanges: fixture.domains.workspaceChanges,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    client = await ActualMountedClient.open("http://127.0.0.1:" + port);
    await login();
    const reads = () =>
      client!.control("reads") as Promise<OperationHttpRead[]>;
    const rows = () =>
      client!.control("storage") as Promise<Record<string, string>>;
    await run({
      get client() {
        assert(client);
        return client;
      },
      reads,
      rows,
      login,
      async remount() {
        await client!.control("remount");
        await client!.waitReady(operationHuman.principalId);
      },
      interceptNext: (path, status = 500) =>
        client!.control("interceptNext", path, status),
      holdNext: (path) => client!.hold(path),
      failNextClear: () => client!.control("failNextClear"),
      sql,
    });
    fixture.assertNoLegacyData();
    assert.equal(
      fixture.transport.runtimeState(),
      null,
      "object interactions start no Runtime",
    );
    const ledger = { reads: await reads(), storage: await rows(), sql: sql() };
    const evidence = process.env.MORPHZ_TEST_OPERATION_DELIVERY_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, name + "-http-ledger.json"),
        JSON.stringify(ledger, null, 2),
      );
    }
    console.log(
      JSON.stringify({
        operationHttp: name,
        requests: ledger.reads.length,
        objects: ledger.sql.objects.length,
        tasks: ledger.sql.tasks.length,
        ledgerSha256: createHash("sha256")
          .update(JSON.stringify(ledger))
          .digest("hex"),
      }),
    );
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((done, reject) =>
            server!.close((error) => (error ? reject(error) : done())),
          );
        }
      } finally {
        try {
          await fixture.close();
        } finally {
          web.close();
        }
      }
    }
    assert.equal(
      existsSync(fixture.directory),
      false,
      "only owned SQL fixture directory removed",
    );
  }
}
