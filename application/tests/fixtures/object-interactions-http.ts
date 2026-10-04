import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { draftOwner } from "../../apps/web/src/local-preferences.js";
import { applicationWindowKey } from "../../packages/core/src/application-names.js";
import { localAccess } from "../../packages/core/src/model.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";
import { seedExistingPdf } from "../objects-existing-pdf-fixture.js";
import { sqliteQuery } from "../../packages/storage/src/sql.js";
import { randomUUID } from "node:crypto";

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
function actualClient() {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  renderToString(createElement(Probe));
  assert(client);
  return client;
}
function storage(rows: Map<string, string>): Storage {
  return {
    get length() {
      return rows.size;
    },
    clear() {
      rows.clear();
    },
    key(n) {
      return [...rows.keys()][n] ?? null;
    },
    getItem(key) {
      return rows.get(key) ?? null;
    },
    setItem(key, value) {
      rows.set(key, value);
    },
    removeItem(key) {
      rows.delete(key);
    },
  };
}
export async function withObjectHttp(
  name: string,
  run: (context: {
    readonly client: WorkspaceClient;
    reads: ObjectHttpRead[];
    rows: Map<string, string>;
    login(other?: boolean): Promise<void>;
    remount(): Promise<void>;
    revoke(): Promise<void>;
    loseNext(path: string): void;
    holdNext(path: string): { reached: Promise<void>; release(): void };
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
  // Real Application/Identity/Platform/Objects and SQLite. Runtime is the
  // existing domain fixture's controlled authority, never started or invoked.
  const fixture = await agentDomainFixture({
    additionalHumans: [objectHuman, otherObjectHuman],
    loginTokenForHuman: token,
  });
  const originals = [
      "window",
      "location",
      "localStorage",
      "sessionStorage",
    ].map((name) => ({
      name,
      descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
    })),
    nativeFetch = globalThis.fetch;
  const reads: ObjectHttpRead[] = [],
    rows = new Map<string, string>(),
    releases: (() => void)[] = [];
  let client: WorkspaceClient | undefined,
    cookies = "",
    intercept:
      | {
          path: string;
          loss?: boolean;
          reached?: () => void;
          pending?: Promise<void>;
        }
      | undefined;
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
  let listening = false;
  const login = async (other = false) => {
    assert(client);
    if (client.getSnapshot()) await client.logout();
    await client.login(token(other ? otherObjectHuman : objectHuman));
  };
  try {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done, reject) =>
      probe.close((error) => (error ? reject(error) : done())),
    );
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
      port,
      webRoot: "/nonexistent",
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    listening = true;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.notEqual(address.port, 65421);
    const origin = "http://127.0.0.1:" + address.port;
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(url.origin, origin, "only isolated owned HTTP origin");
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      const value: unknown = await response.clone().json();
      reads.push({
        path: url.pathname,
        query: url.search,
        method: init?.method ?? "GET",
        status: response.status,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        response: value,
      });
      if (intercept?.path === url.pathname) {
        const held = intercept;
        intercept = undefined;
        assert.equal(
          response.status,
          200,
          "intercept only after real authorized success/commit",
        );
        held.reached?.();
        if (held.pending) await held.pending;
        if (held.loss) throw Error("TEST lost authorized object receipt");
      }
      return response;
    };
    for (const [name, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: storage(rows),
      sessionStorage: storage(new Map([[applicationWindowKey, draftOwner]])),
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    client = actualClient();
    assert.equal(
      reads.length,
      0,
      "SSR Client/owner construction performs zero IO",
    );
    await login();
    await run({
      get client() {
        assert(client);
        return client;
      },
      reads,
      rows,
      login,
      async remount() {
        assert(client);
        await client.logout();
        client = actualClient();
        await login();
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
      loseNext(path) {
        assert.equal(intercept, undefined);
        intercept = { path, loss: true };
      },
      holdNext(path) {
        assert.equal(intercept, undefined);
        let reached!: () => void,
          release!: () => void,
          deadline!: ReturnType<typeof setTimeout>;
        const reachedPromise = new Promise<void>((done, reject) => {
          deadline = setTimeout(
            () => reject(Error("TEST real object HTTP phase not reached")),
            4000,
          );
          reached = () => {
            clearTimeout(deadline);
            done();
          };
        });
        const pending = new Promise<void>((done) => {
          release = () => {
            clearTimeout(deadline);
            done();
          };
        });
        intercept = { path, reached, pending };
        releases.push(release);
        return { reached: reachedPromise, release };
      },
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
    const evidence = process.env.MORPHZ_TEST_OBJECT_INTERACTIONS_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, name + "-http-ledger.json"),
        JSON.stringify({ reads, storage: [...rows], sql: sql() }, null, 2),
      );
    }
    console.log(
      JSON.stringify({
        objectHttp: name,
        requests: reads.length,
        annotations: sql().notes.length,
        relations: sql().relations.length,
        ledgerSha256: createHash("sha256")
          .update(JSON.stringify({ reads, storage: [...rows], sql: sql() }))
          .digest("hex"),
      }),
    );
  } finally {
    releases.forEach((release) => release());
    globalThis.fetch = nativeFetch;
    originals.forEach(({ name, descriptor }) => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
    try {
      if (listening && server) {
        const listeningServer = server;
        listeningServer.closeIdleConnections();
        await new Promise<void>((done, reject) =>
          listeningServer.close((error) => (error ? reject(error) : done())),
        );
      }
    } finally {
      await fixture.close();
    }
    assert.equal(
      existsSync(fixture.directory),
      false,
      "only owned SQL fixture directory removed",
    );
  }
}
