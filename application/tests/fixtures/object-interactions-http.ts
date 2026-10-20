import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { localAccess } from "../../packages/core/src/model.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";
import { seedExistingPdf } from "../objects-existing-pdf-fixture.js";
import { sqliteQuery } from "../../packages/storage/src/sql.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./actual-mounted-client-test.js";

export const objectHuman = {
  principalId: "object-reader-human",
  actantId: "object-reader-actant",
};
export const otherObjectHuman = {
  principalId: "object-reader-other",
  actantId: "object-reader-other-actant",
};
const token = (who: { principalId: string }) =>
  createHash("sha256")
    .update("object-interactions:" + who.principalId)
    .digest("hex");
export type ObjectHttpRead = {
  path: string;
  query: string;
  method: string;
  status: number;
  body: unknown;
  response: unknown;
};
export async function withObjectHttp(
  name: string,
  run: (context: {
    readonly client: ActualMountedClient;
    reads(): Promise<ObjectHttpRead[]>;
    rows(): Promise<Record<string, string>>;
    login(other?: boolean): Promise<void>;
    remount(): Promise<void>;
    revoke(): Promise<void>;
    loseNext(path: string): Promise<void>;
    holdNext(path: string): ReturnType<ActualMountedClient["hold"]>;
    existingPdf(
      projectId: string,
    ): Promise<{ contentId: string; quote: string }>;
    sql(): {
      notes: Record<string, unknown>[];
      objectReceipts: Record<string, unknown>[];
      relations: Record<string, unknown>[];
      workReceipts: Record<string, unknown>[];
    };
  }) => Promise<void>,
) {
  // Mounted React and native browser HTTP/cookies/storage, with real private
  // Application/Identity/Platform/Objects SQLite. Never an SSR business owner.
  const web = await mountedClientWebRoot();
  let fixture: Awaited<ReturnType<typeof agentDomainFixture>>;
  try {
    fixture = await agentDomainFixture({
      additionalHumans: [objectHuman, otherObjectHuman],
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
      });
    try {
      return {
        notes: objects
          .prepare(
            "SELECT * FROM object_annotations ORDER BY collection_ordinal",
          )
          .all() as Record<string, unknown>[],
        objectReceipts: objects
          .prepare(
            "SELECT * FROM object_command_receipts WHERE operation='annotate' ORDER BY command_id",
          )
          .all() as Record<string, unknown>[],
        relations: platform
          .prepare("SELECT * FROM work_relations ORDER BY relation_id")
          .all() as Record<string, unknown>[],
        workReceipts: platform
          .prepare(
            "SELECT * FROM command_receipts WHERE operation='link-work' ORDER BY command_id",
          )
          .all() as Record<string, unknown>[],
      };
    } finally {
      objects.close();
      platform.close();
    }
  };

  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  const login = async (other = false) => {
    assert(client);
    if (await client.snapshot()) await client.call("logout");
    const human = other ? otherObjectHuman : objectHuman;
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
    const reads = () => client!.control("reads") as Promise<ObjectHttpRead[]>;
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
        await client!.waitReady(objectHuman.principalId);
      },
      async revoke() {
        assert(fixture.identity);
        await fixture.identity.replaceConfiguration({
          version: 1,
          members: [localAccess, objectHuman, otherObjectHuman].map((who) => ({
            ...who,
            enabled: who.principalId !== objectHuman.principalId,
            loginTokenHash: createHash("sha256")
              .update(token(who))
              .digest("hex"),
          })),
        });
      },
      loseNext: (path) =>
        client!.control(
          "loseNext",
          path,
          "TEST lost authorized object receipt",
        ),
      holdNext: (path) => client!.hold(path),
      sql,
      async existingPdf(projectId) {
        // Existing Objects PDFs have no public creation command. This is the
        // same current-schema initial-state fixture used by existing media
        // tests, NOT a Human import or byte retrieval proof. All subsequent
        // catalog/read/annotation/page authorization uses the real services.
        const objectId = randomUUID(),
          contentId = "content_" + objectId;
        const quote = "第一PDF页确切原文",
          at = "2026-09-30T00:00:00.000Z";
        const objects = new DatabaseSync(
          join(fixture.directory, "objects.sqlite"),
        );
        try {
          await seedExistingPdf(sqliteQuery(objects), {
            tenantId: fixture.transport.identity(),
            objectId,
            projectId,
            author: objectHuman,
            reference: {
              storeId: "test-existing-pdf",
              artifactId: objectId,
              revision: 1,
              sha256: "a".repeat(64),
              byteLength: 42,
              mime: "application/pdf",
            },
            versions: [
              {
                title: "TEST 已存 Objects PDF",
                pages: [quote, "第二页不同原文"],
              },
            ],
          });
        } finally {
          objects.close();
        }
        const platform = new DatabaseSync(
          join(fixture.directory, "platform.sqlite"),
        );
        try {
          platform
            .prepare(
              "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'available',1,?,?)",
            )
            .run(
              fixture.transport.identity(),
              contentId,
              "morphz.objects",
              fixture.domains.content.instanceIds.objects,
              objectId,
              projectId,
              "pdf",
              "TEST 已存 Objects PDF",
              "1",
              at,
              at,
              at,
            );
        } finally {
          platform.close();
        }
        return { contentId, quote };
      },
    });
    fixture.assertNoLegacyData();
    assert.equal(
      fixture.transport.runtimeState(),
      null,
      "object interactions start no Runtime",
    );
    const ledger = { reads: await reads(), storage: await rows(), sql: sql() };
    const evidence = process.env.MORPHZ_TEST_OBJECT_INTERACTIONS_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, name + "-http-ledger.json"),
        JSON.stringify(ledger, null, 2),
      );
    }
    console.log(
      JSON.stringify({
        objectHttp: name,
        requests: ledger.reads.length,
        annotations: ledger.sql.notes.length,
        relations: ledger.sql.relations.length,
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
