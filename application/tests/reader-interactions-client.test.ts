import assert from "node:assert/strict";
import test from "node:test";
import { RequestError } from "../apps/web/src/application-transport.js";
import { applicationTokenHeader } from "../packages/core/src/application-names.js";
import type { ReaderCommand } from "../packages/core/src/reader.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import {
  readerActor,
  otherReader,
  withReaderInteractions,
} from "./fixtures/reader-interactions-http.js";

test(
  "actual Client imports original bytes through real HTTP/SQLite, lost receipt retry and catalog confirmation",
  { timeout: 30000 },
  async () => {
    await withReaderInteractions(async ({ client, reads, loseNext }) => {
      const file = new File(
        ["# TEST 导入原件\n\n真实导入文字。"],
        "TEST-reader-import.md",
        { type: "text/markdown" },
      );
      reads.length = 0;
      loseNext("/api/import/reading");
      await assert.rejects(
        client.importReading(file, "agent-test-project"),
        /lost authorized receipt/,
      );
      const lost = reads.find((r) => r.path === "/api/import/reading")!;
      assert.equal(lost.status, 201);
      const id = (lost.response as { entityId: string }).entityId;
      const beforeRetry = reads.length;
      const imported = await client.importReading(file, "agent-test-project");
      assert.equal(imported.entityId, id);
      const imports = reads.filter((r) => r.path === "/api/import/reading");
      assert.equal(
        imports[1]!.headers.get("X-Command-Id"),
        imports[0]!.headers.get("X-Command-Id"),
      );
      assert.equal(
        imports[0]!.headers.get("X-Project-Id"),
        "agent-test-project",
      );
      assert.equal(
        decodeURIComponent(imports[0]!.headers.get("X-Source-Path")!),
        file.name,
      );
      assert.equal(
        imports[1]!.headers.get(applicationTokenHeader),
        client.getSnapshot()!.csrfToken,
      );
      assert(
        reads
          .slice(beforeRetry)
          .some((r) => r.path.includes("runtime-navigation")),
        "successful import confirms real current catalog",
      );
      const contents = await client.readingContents(id, 1);
      const section = await client.readReading(id, 1, contents[0]!.id);
      assert.match(section.text, /真实导入文字/);
      await client.importReading(file, "agent-test-project");
      const all = reads.filter((r) => r.path === "/api/import/reading");
      assert.notEqual(
        all[2]!.headers.get("X-Command-Id"),
        all[1]!.headers.get("X-Command-Id"),
        "new explicit success gets new command ID; object cache identity is independent",
      );
    });
  },
);

test(
  "actual Client saves private position and mark receipts, retry/CAS and another authorized Human isolation",
  { timeout: 30000 },
  async () => {
    await withReaderInteractions(
      async ({ client, contentId, section, reads, loseNext, login }) => {
        const start = section.text.indexOf("真实私有");
        assert(start >= 0);
        const location = {
          sourceId: section.sourceId,
          sectionId: section.id,
          start,
          end: start + 4,
        };
        const add: ReaderCommand = {
          action: "mark-add",
          artifactId: contentId,
          artifactRevision: 1,
          location,
          quote: section.text.slice(start, start + 4),
          kind: "note",
          color: "green",
          note: "真实独立Reader标注",
        };
        reads.length = 0;
        loseNext("/api/reader/commands");
        await assert.rejects(
          client.readerCommand(contentId, 1, add),
          /lost authorized receipt/,
        );
        const original = reads.at(-1)!;
        assert.equal(original.status, 200);
        const originalReceipt = original.response as {
          id: string;
          revision: number;
        };
        const retry = await client.readerCommand(contentId, 1, add);
        assert.deepEqual(retry, originalReceipt);
        const commands = reads.filter((r) => r.path === "/api/reader/commands");
        assert.equal(
          (commands[0]!.body as { commandId: string }).commandId,
          (commands[1]!.body as { commandId: string }).commandId,
        );
        assert.equal(
          reads.length,
          2,
          "reading command never adds Client refresh",
        );
        let marks = await client.readingMarks({
          artifactId: contentId,
          revision: 1,
        });
        assert.equal(marks.marks.length, 1);
        assert.equal(marks.marks[0]!.ownerPrincipalId, readerActor.principalId);
        assert.equal(marks.marks[0]!.note, add.note);
        const updated = await client.readerCommand(contentId, 1, {
          action: "mark-update",
          markId: retry.id,
          expectedRevision: retry.revision,
          note: "持久修订",
          color: "blue",
        });
        assert.equal(updated.revision, 2);
        await assert.rejects(
          client.readerCommand(contentId, 1, {
            action: "mark-update",
            markId: retry.id,
            expectedRevision: 1,
            note: "过期CAS",
            color: "pink",
          }),
          (e) => e instanceof RequestError && e.status === 409,
        );
        const saved = await client.readerCommand(contentId, 1, {
          action: "save-position",
          artifactId: contentId,
          artifactRevision: 1,
          location,
          preferences: { fontSize: 23, font: "serif", theme: "night" },
          expectedRevision: 0,
        });
        assert.equal(saved.revision, 1);
        const position = await client.readingState(contentId, 1);
        assert.equal(
          position.position?.ownerPrincipalId,
          readerActor.principalId,
        );
        assert.deepEqual(position.position?.location, location);
        assert.equal(position.position?.preferences.fontSize, 23);
        await login(true);
        assert.equal(
          client.getSnapshot()!.principalId,
          otherReader.principalId,
        );
        assert.equal(
          (await client.readingMarks({ artifactId: contentId, revision: 1 }))
            .marks.length,
          0,
        );
        assert.equal((await client.readingState(contentId, 1)).position, null);
        await login();
        marks = await client.readingMarks({
          artifactId: contentId,
          revision: 1,
        });
        assert.equal(marks.marks[0]!.note, "持久修订");
        assert.equal(
          (await client.readingState(contentId, 1)).position?.revision,
          1,
        );
        const removed = await client.readerCommand(contentId, 1, {
          action: "mark-remove",
          markId: retry.id,
          expectedRevision: 2,
        });
        assert.equal(
          (await client.readingMarks({ artifactId: contentId, revision: 1 }))
            .marks.length,
          0,
        );
        await client.readerCommand(contentId, 1, {
          action: "mark-restore",
          markId: retry.id,
          expectedRevision: removed.revision,
        });
        assert.equal(
          (await client.readingMarks({ artifactId: contentId, revision: 1 }))
            .marks.length,
          1,
        );
      },
    );
  },
);

test(
  "actual Client Reader permission/revision errors do not create marks or share pending retries",
  { timeout: 30000 },
  async () => {
    await withReaderInteractions(
      async ({ client, contentId, section, reads, access }) => {
        const location = {
          sourceId: section.sourceId,
          sectionId: section.id,
          start: 0,
          end: 0,
        };
        const command: ReaderCommand = {
          action: "mark-add",
          artifactId: contentId,
          artifactRevision: 1,
          location,
          quote: "",
          kind: "bookmark",
          color: "yellow",
          note: "",
        };
        await access(false);
        await client.refresh();
        reads.length = 0;
        for (let i = 0; i < 2; i++)
          await assert.rejects(
            client.readerCommand(contentId, 1, command),
            (e) =>
              e instanceof RequestError &&
              e.status === 404 &&
              e.message === "内容不存在或无权访问。",
          );
        const denied = reads.filter((r) => r.path === "/api/reader/commands");
        assert.deepEqual(
          denied.map((r) => r.status),
          [404, 404],
        );
        assert.notEqual(
          (denied[0]!.body as { commandId: string }).commandId,
          (denied[1]!.body as { commandId: string }).commandId,
          "definitive 4xx clears old command retry",
        );
        await access(true);
        await client.refresh();
        assert.equal(
          (await client.readingMarks({ artifactId: contentId, revision: 1 }))
            .marks.length,
          0,
        );
        await client.readerCommand(contentId, 1, command);
        assert.equal(
          (await client.readingMarks({ artifactId: contentId, revision: 1 }))
            .marks.length,
          1,
        );
      },
    );
  },
);

test(
  "actual Client discards held HTTP import/command receipts after identity change and safely retries the original private pending command",
  { timeout: 30000 },
  async () => {
    const pendingIds = (identity: {
      centerId: string;
      principalId: string;
    }) => {
      const ids: string[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)!;
        if (
          key.includes(`${identity.centerId}:${identity.principalId}:`) &&
          (key.includes("pending:file-import:") ||
            key.includes("pending:reader:"))
        ) {
          const value = JSON.parse(localStorage.getItem(key)!);
          if (value?.commandId) ids.push(value.commandId);
        }
      }
      return ids;
    };
    const retiredReceipt = (error: unknown) => {
      assert(error instanceof RequestError);
      assert.equal(error.status, 408);
      assert.equal(error.message, "身份已切换，旧响应已丢弃。");
    };
    await withReaderInteractions(
      async ({ client, reads, holdNext, login, receiptCount }) => {
        const originalIdentity = client.getSnapshot()!;
        const file = new File(
          ["# TEST held import\n\n延迟回执原件。"],
          "TEST-held-import.md",
          { type: "text/markdown" },
        );
        const hold = holdNext("/api/import/reading");
        const pending = client.importReading(file, "agent-test-project").then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        try {
          await hold.reached;
          const first = reads.find((r) => r.path === "/api/import/reading")!;
          assert.equal(first.status, 201);
          const commandId = first.headers.get("X-Command-Id")!;
          const originalReceipt = first.response as { entityId: string };
          assert.equal(receiptCount("import", commandId), 1);
          assert.deepEqual(pendingIds(originalIdentity), [commandId]);
          await login(true);
          const newSnapshot = client.getSnapshot();
          assert.equal(newSnapshot!.principalId, otherReader.principalId);
          assert.deepEqual(pendingIds(newSnapshot!), []);
          hold.release();
          retiredReceipt((await pending).error);
          assert.equal(
            client.getSnapshot(),
            newSnapshot,
            "late import cannot publish or refresh the newer identity",
          );
          assert.deepEqual(pendingIds(originalIdentity), [commandId]);
          await login();
          const retry = await client.importReading(file, "agent-test-project");
          assert.deepEqual(retry, originalReceipt);
          const replay = reads
            .filter((r) => r.path === "/api/import/reading")
            .at(-1)!;
          assert.equal(replay.headers.get("X-Command-Id"), commandId);
          assert.equal(
            receiptCount("import", commandId),
            1,
            "one real SQLite import event after replay",
          );
          assert.deepEqual(pendingIds(originalIdentity), []);
          const contents = await client.readingContents(retry.entityId, 1);
          assert.match(
            (await client.readReading(retry.entityId, 1, contents[0]!.id)).text,
            /延迟回执原件/,
          );
        } finally {
          hold.release();
          await pending;
        }
      },
    );
    await withReaderInteractions(
      async ({
        client,
        contentId,
        section,
        reads,
        holdNext,
        login,
        receiptCount,
      }) => {
        const originalIdentity = client.getSnapshot()!;
        const command: ReaderCommand = {
          action: "mark-add",
          artifactId: contentId,
          artifactRevision: 1,
          location: {
            sourceId: section.sourceId,
            sectionId: section.id,
            start: 0,
            end: 0,
          },
          quote: "",
          kind: "bookmark",
          color: "yellow",
          note: "TEST held private mark",
        };
        const hold = holdNext("/api/reader/commands");
        const pending = client.readerCommand(contentId, 1, command).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        try {
          await hold.reached;
          const first = reads.find((r) => r.path === "/api/reader/commands")!;
          assert.equal(first.status, 200);
          const commandId = (first.body as { commandId: string }).commandId;
          const originalReceipt = first.response as {
            id: string;
            revision: number;
          };
          assert.equal(receiptCount("command", commandId), 1);
          await login(true);
          const newSnapshot = client.getSnapshot();
          assert.equal(
            (await client.readingMarks({ artifactId: contentId, revision: 1 }))
              .marks.length,
            0,
          );
          assert.deepEqual(pendingIds(newSnapshot!), []);
          hold.release();
          retiredReceipt((await pending).error);
          assert.equal(
            client.getSnapshot(),
            newSnapshot,
            "late command does not replace the newer snapshot",
          );
          assert.deepEqual(pendingIds(originalIdentity), [commandId]);
          await login();
          const retry = await client.readerCommand(contentId, 1, command);
          assert.deepEqual(retry, originalReceipt);
          const replay = reads
            .filter((r) => r.path === "/api/reader/commands")
            .at(-1)!;
          assert.equal(
            (replay.body as { commandId: string }).commandId,
            commandId,
          );
          assert.equal(
            receiptCount("command", commandId),
            1,
            "one real SQLite command receipt after replay",
          );
          const marks = await client.readingMarks({
            artifactId: contentId,
            revision: 1,
          });
          assert.equal(marks.marks.length, 1);
          assert.equal(marks.marks[0]!.id, retry.id);
          assert.equal(
            marks.marks[0]!.ownerPrincipalId,
            readerActor.principalId,
          );
          assert.deepEqual(pendingIds(originalIdentity), []);
        } finally {
          hold.release();
          await pending;
        }
      },
    );
  },
);

test(
  "actual Client public OCR uses controlled logical bridge only, preserves cancellation and identity generation",
  { timeout: 30000 },
  async () => {
    await withReaderInteractions(async ({ client, contentId, login }) => {
      const nativeWindow = window,
        requests: ApplicationInvocation[] = [],
        cancelled: string[] = [];
      let accept!: (reply: ApplicationReply) => void;
      const status = {
        available: true,
        installed: false,
        downloadBytes: 0,
        state: "idle" as const,
      };
      let held = false;
      const bridge = {
        invoke: async (
          request: ApplicationInvocation,
        ): Promise<ApplicationReply> => {
          assert.equal(
            request.method,
            "reader.ocr",
            "no provider, model, other business operation on controlled bridge",
          );
          requests.push(request);
          if (held)
            return new Promise((done) => {
              accept = done;
            });
          return { ok: true, value: status };
        },
        cancel(id: string) {
          cancelled.push(id);
        },
      };
      const setBridge = (enabled: boolean) => {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: enabled
            ? { morphzDesktop: { application: bridge } }
            : nativeWindow,
        });
      };
      try {
        setBridge(true);
        const request = {
          operation: "status" as const,
          artifactId: contentId,
          revision: 1,
          page: 1,
        };
        const generation = client.getSnapshot()!.csrfToken;
        assert.equal(
          await client.readingOcr(request, undefined, generation),
          status,
        );
        assert.equal(requests[0]!.identityGeneration, generation);
        assert.deepEqual(requests[0]!.params, request);
        await assert.rejects(
          client.readingOcr(request, undefined, "obsolete"),
          /阅读权限已变化/,
        );
        assert.equal(requests.length, 1);
        const already = new AbortController();
        already.abort();
        await assert.rejects(
          client.readingOcr(request, already.signal),
          (e) => e instanceof Error && e.name === "AbortError",
        );
        assert.equal(requests.length, 1);
        held = true;
        const abort = new AbortController();
        const pending = client.readingOcr(request, abort.signal).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        await Promise.resolve();
        assert.equal(requests.length, 2);
        abort.abort();
        accept({ ok: true, value: status });
        const cancelledResult = await pending;
        assert(
          cancelledResult.error instanceof Error &&
            cancelledResult.error.name === "AbortError",
        );
        assert.deepEqual(cancelled, [requests[1]!.id]);
        const old = client.readingOcr(request).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        await Promise.resolve();
        assert.equal(requests.length, 3);
        setBridge(false);
        await login(true);
        const snapshot = client.getSnapshot();
        setBridge(true);
        accept({ ok: true, value: status });
        const retired = await old;
        assert(
          retired.error instanceof Error && retired.error.name === "AbortError",
        );
        assert.equal(client.getSnapshot(), snapshot);
        assert.equal(snapshot!.principalId, otherReader.principalId);
      } finally {
        setBridge(false);
      }
    });
  },
);
