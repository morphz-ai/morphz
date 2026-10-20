import assert from "node:assert/strict";
import test from "node:test";
import {
  documentReport,
  hostReport,
  pairedBrowser,
  withPairedDocument,
} from "./fixtures/cognitive-document-paired-port-mounted.js";

// Actual Chromium + unchanged production fixed wrapper and private Host endpoint.
// Observe the original peer, not opaque-child pre-script instrumentation. This
// is not a packed SDK, SQL, real author service, Native App or production consumer.
test(
  "ACTUAL Chromium paired ports: Doc→held Host caps sixteen native wires including its unique early connect; actual credits restore without retry",
  { timeout: 30000 },
  async () => {
    const browser = await pairedBrowser();
    try {
      await withPairedDocument(
        browser,
        { holdHost: true },
        async (page, frame) => {
          const burst = await frame.evaluate(() => {
            const facade = Reflect.get(window, "pairedAuthor");
            let sent = 0,
              rejected = 0;
            for (let index = 0; index < 1000; index++) {
              try {
                facade.send(JSON.stringify(["doc-held", index]));
                sent++;
              } catch {
                rejected++;
              }
            }
            return { sent, rejected };
          });
          assert.deepEqual(burst, { sent: 15, rejected: 985 });
          const held = await hostReport(page);
          assert.equal(held.attached, false);
          assert.equal(held.ready, 0);
          assert.deepEqual(held.hostWires, []);
          assert.equal(
            await frame.evaluate(() => Reflect.has(window, "pairedNativeGate")),
            false,
            "Fixed-wrapper E2E must not depend on a child native hook.",
          );
          await page.evaluate(() =>
            Reflect.get(window, "pairedHost").releasePeer(),
          );
          await page.waitForFunction(
            () =>
              Reflect.get(window, "pairedHost").report().hostWires.length ===
              16,
          );
          const drained = await hostReport(page);
          assert.equal(
            drained.hostFrames.filter((packet) => packet.kind === "wire")
              .length,
            16,
          );
          assert.deepEqual(
            drained.hostFrames.filter(
              (packet) => packet.kind === "parser-ready",
            ),
            [{ kind: "parser-ready" }],
          );
          assert.equal(drained.ready, 1);
          assert.equal(
            drained.hostWires[0],
            '{"type":"morphz-cognitive-ui/v1:connect"}',
          );
          assert.deepEqual(
            drained.hostWires.slice(1),
            Array.from({ length: 15 }, (_, index) =>
              JSON.stringify(["doc-held", index]),
            ),
          );
          assert.deepEqual(
            drained.hostPosts.filter((packet) => packet.kind === "credit"),
            Array.from({ length: 16 }, (_, index) => ({
              kind: "credit",
              sequence: index + 1,
            })),
          );
          // A real Host wire follows those credits on the same native FIFO. Its
          // actual Document callback is the proof the credits have been consumed.
          await page.evaluate(() =>
            Reflect.get(window, "pairedHost").send('"credits-drained"'),
          );
          await frame.waitForFunction(() =>
            Reflect.get(window, "pairedAuthor")
              .report()
              .received.includes('"credits-drained"'),
          );
          const resumed = await frame.evaluate(() => {
            const facade = Reflect.get(window, "pairedAuthor");
            let sent = 0,
              rejected = 0;
            for (let index = 0; index < 17; index++) {
              try {
                facade.send(JSON.stringify(["doc-resumed", index]));
                sent++;
              } catch {
                rejected++;
              }
            }
            return { sent, rejected };
          });
          assert.deepEqual(resumed, { sent: 16, rejected: 1 });
          await page.waitForFunction(
            () =>
              Reflect.get(window, "pairedHost").report().hostWires.length ===
              32,
          );
          const final = await hostReport(page);
          assert.deepEqual(
            final.hostFrames.filter((packet) => packet.kind === "wire"),
            [
              {
                kind: "wire",
                text: '{"type":"morphz-cognitive-ui/v1:connect"}',
              },
              ...Array.from({ length: 15 }, (_, index) => ({
                kind: "wire",
                text: JSON.stringify(["doc-held", index]),
              })),
              ...Array.from({ length: 16 }, (_, index) => ({
                kind: "wire",
                text: JSON.stringify(["doc-resumed", index]),
              })),
            ],
            "The final real FIFO wire bounds the complete preceding native receipt trace.",
          );
          assert.deepEqual(
            final.hostWires.slice(16),
            Array.from({ length: 16 }, (_, index) =>
              JSON.stringify(["doc-resumed", index]),
            ),
          );
          assert.equal(
            final.hostWires.includes(JSON.stringify(["doc-held", 15])),
            false,
          );
          assert.equal(
            final.hostWires.includes(JSON.stringify(["doc-resumed", 16])),
            false,
          );
          assert.equal(final.retired, 0);
        },
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "ACTUAL Chromium fixed wrapper: synchronous Host burst caps sixteen before credit consumption; real Document callbacks reopen one window",
  { timeout: 30000 },
  async () => {
    const browser = await pairedBrowser();
    try {
      await withPairedDocument(browser, {}, async (page, frame) => {
        await page.waitForFunction(
          () => Reflect.get(window, "pairedHost").report().ready === 1,
        );
        assert.deepEqual((await documentReport(frame)).received, []);
        const burst = await page.evaluate(() => {
          const host = Reflect.get(window, "pairedHost");
          const creditsBefore = host
            .report()
            .hostFrames.filter(
              (packet: { kind: string }) => packet.kind === "credit",
            ).length;
          let sent = 0,
            rejected = 0;
          const codes: string[] = [];
          for (let index = 0; index < 1000; index++) {
            try {
              host.send(JSON.stringify(["host-sync", index]));
              sent++;
            } catch (error) {
              rejected++;
              codes.push(Reflect.get(error as object, "code"));
            }
          }
          // A single synchronous Host task cannot consume incoming message
          // tasks, even when the actual opaque Document is already running.
          return {
            sent,
            rejected,
            codes,
            creditsBefore,
            creditsAfter: host
              .report()
              .hostFrames.filter(
                (packet: { kind: string }) => packet.kind === "credit",
              ).length,
          };
        });
        assert.equal(burst.creditsBefore, 0);
        assert.equal(burst.creditsAfter, 0);
        assert.equal(burst.sent, 16);
        assert.equal(burst.rejected, 984);
        assert.equal(
          burst.codes.every((code) => code === "busy"),
          true,
        );
        assert.equal(
          (await hostReport(page)).hostPosts.filter(
            (packet) => packet.kind === "wire",
          ).length,
          16,
        );
        await frame.waitForFunction(
          () =>
            Reflect.get(window, "pairedAuthor").report().received.length === 16,
        );
        const drained = await documentReport(frame);
        assert.deepEqual(
          drained.received,
          Array.from({ length: 16 }, (_, index) =>
            JSON.stringify(["host-sync", index]),
          ),
        );
        // This real reverse wire follows all sixteen Document credits, proving
        // the Host helper consumed each credit before the second synchronous burst.
        await frame.evaluate(() =>
          Reflect.get(window, "pairedAuthor").send('"document-drained"'),
        );
        await page.waitForFunction(() =>
          Reflect.get(window, "pairedHost")
            .report()
            .hostWires.includes('"document-drained"'),
        );
        assert.deepEqual(
          (await hostReport(page)).hostFrames.filter(
            (packet) => packet.kind === "credit",
          ),
          Array.from({ length: 16 }, (_, index) => ({
            kind: "credit",
            sequence: index + 1,
          })),
        );
        const resumed = await page.evaluate(() => {
          const host = Reflect.get(window, "pairedHost");
          let sent = 0,
            rejected = 0;
          for (let index = 0; index < 17; index++) {
            try {
              host.send(JSON.stringify(["host-resumed", index]));
              sent++;
            } catch {
              rejected++;
            }
          }
          return { sent, rejected };
        });
        assert.deepEqual(resumed, { sent: 16, rejected: 1 });
        await frame.waitForFunction(
          () =>
            Reflect.get(window, "pairedAuthor").report().received.length === 32,
        );
        const final = await documentReport(frame);
        assert.deepEqual(
          final.received.slice(16),
          Array.from({ length: 16 }, (_, index) =>
            JSON.stringify(["host-resumed", index]),
          ),
        );
        assert.equal(
          final.received.includes(JSON.stringify(["host-sync", 16])),
          false,
        );
        assert.equal(
          final.received.includes(JSON.stringify(["host-resumed", 16])),
          false,
        );
        assert.equal((await hostReport(page)).retired, 0);
      });
    } finally {
      await browser.close();
    }
  },
);

test(
  "ACTUAL Chromium fixed wrapper: callback retirement delivers no Host credit, retains only fifteen slots and does not invent mutual retirement",
  { timeout: 30000 },
  async () => {
    const browser = await pairedBrowser();
    try {
      await withPairedDocument(browser, {}, async (page, frame) => {
        await page.waitForFunction(
          () => Reflect.get(window, "pairedHost").report().ready === 1,
        );
        await page.evaluate(() =>
          Reflect.get(window, "pairedHost").send('"retire-during-callback"'),
        );
        await frame.waitForFunction(
          () => Reflect.get(window, "pairedAuthor").report().callbackRetired,
        );
        const document = await documentReport(frame);
        assert.deepEqual(document.received, ['"retire-during-callback"']);
        assert.deepEqual(
          (await hostReport(page)).hostFrames.filter(
            (packet) => packet.kind === "credit",
          ),
          [],
        );
        const rejected = await frame.evaluate(() => {
          try {
            Reflect.get(window, "pairedAuthor").send(
              '"old-author-after-retire"',
            );
            return false;
          } catch {
            return true;
          }
        });
        assert.equal(rejected, true);
        assert.equal(
          (await hostReport(page)).retired,
          0,
          "No invented mutual retirement notification.",
        );
        const remaining = await page.evaluate(() => {
          const host = Reflect.get(window, "pairedHost");
          let sent = 0,
            rejected = 0;
          for (let index = 0; index < 16; index++) {
            try {
              host.send(JSON.stringify(["old-host-remainder", index]));
              sent++;
            } catch {
              rejected++;
            }
          }
          return { sent, rejected };
        });
        assert.deepEqual(remaining, { sent: 15, rejected: 1 });
        assert.equal(
          (await hostReport(page)).hostPosts.filter(
            (packet) => packet.kind === "wire",
          ).length,
          16,
        );
        assert.deepEqual(
          (await hostReport(page)).hostFrames.filter(
            (packet) => packet.kind === "credit",
          ),
          [],
        );
        // Neither close() nor unchanged callback counts claim browser queue GC.
      });
    } finally {
      await browser.close();
    }
  },
);
