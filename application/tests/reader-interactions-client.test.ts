import assert from "node:assert/strict";
import test from "node:test";
import type { ActualMountedClient } from "./fixtures/actual-mounted-client-test.js";
const isRequestError = (error: unknown): error is Error & { status: number } =>
  error instanceof Error && typeof Reflect.get(error, "status") === "number";
import { applicationTokenHeader } from "../packages/core/src/application-names.js";
import type { ReaderCommand } from "../packages/core/src/reader.js";
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
      await client.control("clearReads");
      await loseNext("/api/import/reading");
      await assert.rejects(
        client.call("importReading", [file, "agent-test-project"]),
        /lost authorized receipt/,
      );
      const lost = (await reads()).find(
        (r) => r.path === "/api/import/reading",
      )!;
      assert.equal(lost.status, 201);
      const id = (lost.response as { entityId: string }).entityId;
      const beforeRetry = (await reads()).length;
      const imported = await client.call("importReading", [
        file,
        "agent-test-project",
      ]);
      assert.equal(imported.entityId, id);
      const imports = (await reads()).filter(
        (r) => r.path === "/api/import/reading",
      );
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
        (await client.snapshot())!.csrfToken,
      );
      assert(
        (await reads())
          .slice(beforeRetry)
          .some((r) => r.path.includes("runtime-navigation")),
        "successful import confirms real current catalog",
      );
      const contents = await client.call("readingContents", [id, 1]);
      const section = await client.call("readReading", [
        id,
        1,
        contents[0]!.id,
      ]);
      assert.match(section.text, /真实导入文字/);
      await client.call("importReading", [file, "agent-test-project"]);
      const all = (await reads()).filter(
        (r) => r.path === "/api/import/reading",
      );
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
        await client.control("clearReads");
        await loseNext("/api/reader/commands");
        await assert.rejects(
          client.call("readerCommand", [contentId, 1, add]),
          /lost authorized receipt/,
        );
        const original = (await reads())
          .filter((row) => row.path === "/api/reader/commands")
          .at(-1)!;
        assert.equal(original.status, 200);
        const originalReceipt = original.response as {
          id: string;
          revision: number;
        };
        const retry = await client.call("readerCommand", [contentId, 1, add]);
        assert.deepEqual(retry, originalReceipt);
        const commands = (await reads()).filter(
          (r) => r.path === "/api/reader/commands",
        );
        assert.equal(
          (commands[0]!.body as { commandId: string }).commandId,
          (commands[1]!.body as { commandId: string }).commandId,
        );
        assert.equal(
          commands.length,
          2,
          "one exact command and its retry; mounted workspace notifications may independently refresh",
        );
        assert.deepEqual(
          (await reads())
            .filter((row) => row.method === "POST")
            .map((row) => row.path),
          ["/api/reader/commands", "/api/reader/commands"],
          "no additional business mutation is dispatched",
        );
        let marks = await client.call("readingMarks", [
          {
            artifactId: contentId,
            revision: 1,
          },
        ]);
        assert.equal(marks.marks.length, 1);
        assert.equal(marks.marks[0]!.ownerPrincipalId, readerActor.principalId);
        assert.equal(marks.marks[0]!.note, add.note);
        const updated = await client.call("readerCommand", [
          contentId,
          1,
          {
            action: "mark-update",
            markId: retry.id,
            expectedRevision: retry.revision,
            note: "持久修订",
            color: "blue",
          },
        ]);
        assert.equal(updated.revision, 2);
        await assert.rejects(
          client.call("readerCommand", [
            contentId,
            1,
            {
              action: "mark-update",
              markId: retry.id,
              expectedRevision: 1,
              note: "过期CAS",
              color: "pink",
            },
          ]),
          (e) => isRequestError(e) && e.status === 409,
        );
        const saved = await client.call("readerCommand", [
          contentId,
          1,
          {
            action: "save-position",
            artifactId: contentId,
            artifactRevision: 1,
            location,
            preferences: { fontSize: 23, font: "serif", theme: "night" },
            expectedRevision: 0,
          },
        ]);
        assert.equal(saved.revision, 1);
        const position = await client.call("readingState", [contentId, 1]);
        assert.equal(
          position.position?.ownerPrincipalId,
          readerActor.principalId,
        );
        assert.deepEqual(position.position?.location, location);
        assert.equal(position.position?.preferences.fontSize, 23);
        await login(true);
        assert.equal(
          (await client.snapshot())!.principalId,
          otherReader.principalId,
        );
        assert.equal(
          (
            await client.call("readingMarks", [
              { artifactId: contentId, revision: 1 },
            ])
          ).marks.length,
          0,
        );
        assert.equal(
          (await client.call("readingState", [contentId, 1])).position,
          null,
        );
        await login();
        marks = await client.call("readingMarks", [
          {
            artifactId: contentId,
            revision: 1,
          },
        ]);
        assert.equal(marks.marks[0]!.note, "持久修订");
        assert.equal(
          (await client.call("readingState", [contentId, 1])).position
            ?.revision,
          1,
        );
        const removed = await client.call("readerCommand", [
          contentId,
          1,
          {
            action: "mark-remove",
            markId: retry.id,
            expectedRevision: 2,
          },
        ]);
        assert.equal(
          (
            await client.call("readingMarks", [
              { artifactId: contentId, revision: 1 },
            ])
          ).marks.length,
          0,
        );
        await client.call("readerCommand", [
          contentId,
          1,
          {
            action: "mark-restore",
            markId: retry.id,
            expectedRevision: removed.revision,
          },
        ]);
        assert.equal(
          (
            await client.call("readingMarks", [
              { artifactId: contentId, revision: 1 },
            ])
          ).marks.length,
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
        await client.call("refresh", []);
        await client.control("clearReads");
        for (let i = 0; i < 2; i++)
          await assert.rejects(
            client.call("readerCommand", [contentId, 1, command]),
            (e) =>
              isRequestError(e) &&
              e.status === 404 &&
              e.message === "内容不存在或无权访问。",
          );
        const denied = (await reads()).filter(
          (r) => r.path === "/api/reader/commands",
        );
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
        await client.call("refresh", []);
        assert.equal(
          (
            await client.call("readingMarks", [
              { artifactId: contentId, revision: 1 },
            ])
          ).marks.length,
          0,
        );
        await client.call("readerCommand", [contentId, 1, command]);
        assert.equal(
          (
            await client.call("readingMarks", [
              { artifactId: contentId, revision: 1 },
            ])
          ).marks.length,
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
    const pendingIds = async (
      client: ActualMountedClient,
      identity: { centerId: string; principalId: string },
    ) => {
      const ids: string[] = [];
      for (const [key, text] of Object.entries(
        (await client.control("storage")) as Record<string, string>,
      )) {
        if (
          key.includes(`${identity.centerId}:${identity.principalId}:`) &&
          (key.includes("pending:file-import:") ||
            key.includes("pending:reader:"))
        ) {
          const value = JSON.parse(text);
          if (value?.commandId) ids.push(value.commandId);
        }
      }
      return ids;
    };
    const retiredReceipt = (error: unknown) => {
      assert(isRequestError(error));
      assert.equal(error.status, 408);
      assert.equal(error.message, "身份已切换，旧响应已丢弃。");
    };
    await withReaderInteractions(
      async ({ client, reads, holdNext, login, receiptCount }) => {
        const originalIdentity = (await client.snapshot())!;
        const file = new File(
          ["# TEST held import\n\n延迟回执原件。"],
          "TEST-held-import.md",
          { type: "text/markdown" },
        );
        const hold = await holdNext("/api/import/reading");
        const pending = client
          .call("importReading", [file, "agent-test-project"])
          .then(
            (value) => ({ value, error: undefined }),
            (error) => ({ value: undefined, error }),
          );
        try {
          await hold.reached();
          const first = (await reads()).find(
            (r) => r.path === "/api/import/reading",
          )!;
          assert.equal(first.status, 201);
          const commandId = first.headers.get("X-Command-Id")!;
          const originalReceipt = first.response as { entityId: string };
          assert.equal(receiptCount("import", commandId), 1);
          assert.deepEqual(await pendingIds(client, originalIdentity), [
            commandId,
          ]);
          await login(true);
          const newSnapshot = await client.snapshot("newIdentity");
          assert.equal(newSnapshot!.principalId, otherReader.principalId);
          assert.deepEqual(await pendingIds(client, newSnapshot!), []);
          await hold.release();
          retiredReceipt((await pending).error);
          assert.equal(
            await client.control("sameSnapshot", "newIdentity"),
            true,
            "late import cannot publish or refresh the newer identity",
          );
          assert.deepEqual(await pendingIds(client, originalIdentity), [
            commandId,
          ]);
          await login();
          const retry = await client.call("importReading", [
            file,
            "agent-test-project",
          ]);
          assert.deepEqual(retry, originalReceipt);
          const replay = (await reads())
            .filter((r) => r.path === "/api/import/reading")
            .at(-1)!;
          assert.equal(replay.headers.get("X-Command-Id"), commandId);
          assert.equal(
            receiptCount("import", commandId),
            1,
            "one real SQLite import event after replay",
          );
          assert.deepEqual(await pendingIds(client, originalIdentity), []);
          const contents = await client.call("readingContents", [
            retry.entityId,
            1,
          ]);
          assert.match(
            (
              await client.call("readReading", [
                retry.entityId,
                1,
                contents[0]!.id,
              ])
            ).text,
            /延迟回执原件/,
          );
        } finally {
          await hold.release();
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
        const originalIdentity = (await client.snapshot())!;
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
        const hold = await holdNext("/api/reader/commands");
        const pending = client
          .call("readerCommand", [contentId, 1, command])
          .then(
            (value) => ({ value, error: undefined }),
            (error) => ({ value: undefined, error }),
          );
        try {
          await hold.reached();
          const first = (await reads()).find(
            (r) => r.path === "/api/reader/commands",
          )!;
          assert.equal(first.status, 200);
          const commandId = (first.body as { commandId: string }).commandId;
          const originalReceipt = first.response as {
            id: string;
            revision: number;
          };
          assert.equal(receiptCount("command", commandId), 1);
          await login(true);
          const newSnapshot = await client.snapshot("newIdentity");
          assert.equal(
            (
              await client.call("readingMarks", [
                { artifactId: contentId, revision: 1 },
              ])
            ).marks.length,
            0,
          );
          assert.deepEqual(await pendingIds(client, newSnapshot!), []);
          await hold.release();
          retiredReceipt((await pending).error);
          assert.equal(
            await client.control("sameSnapshot", "newIdentity"),
            true,
            "late command does not replace the newer snapshot",
          );
          assert.deepEqual(await pendingIds(client, originalIdentity), [
            commandId,
          ]);
          await login();
          const retry = await client.call("readerCommand", [
            contentId,
            1,
            command,
          ]);
          assert.deepEqual(retry, originalReceipt);
          const replay = (await reads())
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
          const marks = await client.call("readingMarks", [
            {
              artifactId: contentId,
              revision: 1,
            },
          ]);
          assert.equal(marks.marks.length, 1);
          assert.equal(marks.marks[0]!.id, retry.id);
          assert.equal(
            marks.marks[0]!.ownerPrincipalId,
            readerActor.principalId,
          );
          assert.deepEqual(await pendingIds(client, originalIdentity), []);
        } finally {
          await hold.release();
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
      const waitRequests = async (count: number) =>
        client.page.waitForFunction(
          (n) =>
            Reflect.get(window, "actualMountedClient").ocrReport().requests
              .length === n,
          count,
        );
      try {
        await client.control("ocrInstall", true);
        const request = {
          operation: "status" as const,
          artifactId: contentId,
          revision: 1,
          page: 1,
        };
        const generation = (await client.snapshot())!.csrfToken;
        await client.call(
          "readingOcr",
          [request, undefined, generation],
          "ocr-result",
        );
        assert.equal(
          await client.control("sameResult", "ocr-status", "ocr-result"),
          true,
        );
        let report = await client.control("ocrReport");
        assert.equal(report.requests[0].identityGeneration, generation);
        assert.deepEqual(report.requests[0].params, request);
        await assert.rejects(
          client.call("readingOcr", [request, undefined, "obsolete"]),
          /阅读权限已变化/,
        );
        assert.equal((await client.control("ocrReport")).requests.length, 1);
        const already = new AbortController();
        already.abort();
        await assert.rejects(
          client.call("readingOcr", [request, already.signal]),
          (e) => e instanceof Error && e.name === "AbortError",
        );
        assert.equal((await client.control("ocrReport")).requests.length, 1);
        await client.control("ocrInstall", true, true);
        const abort = new AbortController();
        const pending = client.call("readingOcr", [request, abort.signal]).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        await waitRequests(2);
        abort.abort();
        await client.page.waitForFunction(
          () =>
            Reflect.get(window, "actualMountedClient").ocrReport().cancelled
              .length === 1,
        );
        await client.control("ocrResolve");
        const cancelled = await pending;
        assert(
          cancelled.error instanceof Error &&
            cancelled.error.name === "AbortError",
        );
        report = await client.control("ocrReport");
        assert.deepEqual(report.cancelled, [report.requests[1].id]);
        const old = client.call("readingOcr", [request]).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        await waitRequests(3);
        await client.control("ocrInstall", false);
        await login(true);
        const snapshot = await client.snapshot("afterOcrIdentity");
        await client.control("ocrInstall", true, true);
        await client.control("ocrResolve");
        const retired = await old;
        assert(
          retired.error instanceof Error && retired.error.name === "AbortError",
        );
        assert.equal(
          await client.control("sameSnapshot", "afterOcrIdentity"),
          true,
        );
        assert.equal(snapshot!.principalId, otherReader.principalId);
      } finally {
        await client.control("ocrInstall", false);
      }
    });
  },
);
