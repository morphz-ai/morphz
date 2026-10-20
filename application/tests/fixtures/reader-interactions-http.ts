import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as probePort } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./actual-mounted-client-test.js";
import { createAppServer } from "../../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../../packages/application/src/application.js";
import type { ApplicationMethod } from "../../packages/core/src/application-api.js";
import { localAccess } from "../../packages/core/src/model.js";
import type { ReadingSection } from "../../packages/core/src/reader.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";

export const readerActor = {
  principalId: "reader-interaction-human",
  actantId: "reader-interaction-actant",
};
export const otherReader = {
  principalId: "reader-interaction-other",
  actantId: "reader-interaction-other-actant",
};
const token = (who: { principalId: string }) =>
  createHash("sha256")
    .update("reader-interaction-" + who.principalId)
    .digest("hex");
export type ReaderHttpRead = {
  path: string;
  method: string;
  status: number;
  headers: Headers;
  body: unknown;
  response: unknown;
};
// Mounted Client and actual HTTP/Platform/Reader SQLite. Only transport
// receipt loss/holds are injected after genuine server replies. No Runtime or
// OCR provider is executed, and no production center/profile is opened.
export async function withReaderInteractions(
  run: (context: {
    client: ActualMountedClient;
    contentId: string;
    section: ReadingSection;
    reads(): Promise<ReaderHttpRead[]>;
    login(other?: boolean): Promise<void>;
    access(enabled: boolean): Promise<void>;
    loseNext(path: string): Promise<void>;
    holdNext(path: string): ReturnType<ActualMountedClient["hold"]>;
    receiptCount(kind: "import" | "command", commandId: string): number;
  }) => Promise<void>,
) {
  const web = await mountedClientWebRoot();
  const fixture = await agentDomainFixture({
    additionalHumans: [readerActor, otherReader],
    loginTokenForHuman: token,
  }).catch((error) => {
    web.close();
    throw error;
  });
  const options = {
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
  };
  const app = new Application(fixture.transport, options);
  const call = (method: ApplicationMethod, params: unknown) =>
    invokeApplication(
      app.session(localAccess),
      method,
      params,
      "reader-interaction-test",
      new AbortController().signal,
    );
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  try {
    const created = (await call("documents.create", {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: fixture.projectId,
      title: "TEST Reader real interactions",
      markdown: "# 原章节\n\n真实私有阅读位置与精确标注。",
    })) as { contentId: string };
    const access = async (enabled: boolean) =>
      fixture.domains.content.platform.reconcileOperatorMembers(
        fixture.transport.identity(),
        [
          { ...localAccess, enabled: true, projectIds: [] },
          {
            ...readerActor,
            enabled: true,
            projectIds: enabled ? [fixture.projectId] : [],
          },
          { ...otherReader, enabled: true, projectIds: [fixture.projectId] },
        ],
      );
    await access(true);
    const probe = probePort();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421);
    const origin = "http://127.0.0.1:" + port;
    server = createAppServer(fixture.transport, {
      ...options,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    client = await ActualMountedClient.open(origin);
    const reads = async (): Promise<ReaderHttpRead[]> =>
      (await client!.control("reads")).map(
        (
          value: Omit<ReaderHttpRead, "headers"> & {
            headers: Array<[string, string]>;
          },
        ) => ({ ...value, headers: new Headers(value.headers) }),
      );
    const login = async (other = false) => {
      if (await client!.snapshot()) await client!.call("logout");
      const human = other ? otherReader : readerActor;
      await client!.call("login", [token(human)]);
      await client!.waitReady(human.principalId);
    };
    await login();
    const contents = await client.call("readingContents", [
      created.contentId,
      1,
    ]);
    const section = await client.call("readReading", [
      created.contentId,
      1,
      contents[0]!.id,
    ]);
    await run({
      client,
      contentId: created.contentId,
      section,
      reads,
      login,
      access: async (enabled) => {
        await access(enabled);
      },
      loseNext: (path) =>
        client!.control("loseNext", path, "TEST lost authorized receipt"),
      holdNext: (path) => client!.hold(path),
      receiptCount(kind, commandId) {
        const database = new DatabaseSync(
          join(fixture.directory, "reader.sqlite"),
          {
            readOnly: true,
          },
        );
        try {
          const table =
            kind === "import"
              ? "reader_book_events"
              : "reader_command_receipts";
          return Number(
            database
              .prepare(
                `SELECT count(*) AS count FROM ${table} WHERE command_id=?`,
              )
              .get(commandId)!.count,
          );
        } finally {
          database.close();
        }
      },
    });
    fixture.assertNoLegacyData();
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
  }
}
