import assert from "node:assert/strict";
import test from "node:test";
import {
  hostReport,
  pairedBrowser,
} from "./fixtures/cognitive-document-paired-port-mounted.js";
import {
  controlledDocumentReport as documentReport,
  withControlledPrefix,
} from "./fixtures/cognitive-document-prefix-controlled-mounted.js";

// CONTROLLED parser-order harness. The original production prefix is executed,
// not reimplemented; only the explicitly named mutant alters its one guard.
// This is separate from the unchanged-wrapper end-to-end tests.
for (const controlledDuplicateGuardRemoval of [false, true]) {
  test(
    controlledDuplicateGuardRemoval
      ? "CONTROLLED old fixture: repeated same-Document init resets the observer to zero while sixteen actual native wires survive"
      : "CONTROLLED prefix harness: same-Document init is idempotent and late first instrumentation is rejected",
    { timeout: 30000 },
    async () => {
      const browser = await pairedBrowser();
      try {
        await withControlledPrefix(
          browser,
          { holdHost: true, controlledDuplicateGuardRemoval },
          async (page, frame, instrumentation) => {
            const burst = await frame.evaluate(() => {
              const author = Reflect.get(window, "pairedAuthor");
              let sent = 0,
                rejected = 0;
              for (let index = 0; index < 1000; index++) {
                try {
                  author.send(JSON.stringify(["duplicate-init", index]));
                  sent++;
                } catch {
                  rejected++;
                }
              }
              Reflect.set(
                window,
                "pairedGateBeforeRepeat",
                Reflect.get(window, "pairedNativeGate"),
              );
              Reflect.set(
                window,
                "pairedPostBeforeRepeat",
                MessagePort.prototype.postMessage,
              );
              return { sent, rejected };
            });
            assert.deepEqual(burst, { sent: 15, rejected: 985 });
            const before = await documentReport(frame);
            assert.equal(before.installations[0]!.facadePresent, false);
            assert.equal(before.installations[0]!.wirePosts, 16);
            assert.equal(before.installations[0]!.parserReadyPosts, 1);
            assert.deepEqual((await hostReport(page)).hostWires, []);

            // Reproduce the old observer's duplicate-init failure explicitly in
            // this already composed CONTROLLED Document. Do not depend on a
            // driver race or change the running production prefix/native frames.
            await instrumentation.repeatInitScript();
            const after = await documentReport(frame);
            const identity = await frame.evaluate(() => ({
              sameGate:
                Reflect.get(window, "pairedGateBeforeRepeat") ===
                Reflect.get(window, "pairedNativeGate"),
              samePost:
                Reflect.get(window, "pairedPostBeforeRepeat") ===
                MessagePort.prototype.postMessage,
            }));
            assert.deepEqual(identity, {
              sameGate: !controlledDuplicateGuardRemoval,
              samePost: !controlledDuplicateGuardRemoval,
            });
            assert.equal(
              after.duplicateExecutions,
              before.duplicateExecutions + 1,
            );
            assert.equal(
              after.installations.length,
              before.installations.length +
                Number(controlledDuplicateGuardRemoval),
            );
            assert.equal(
              after.posts.filter((packet) => packet.kind === "wire").length,
              controlledDuplicateGuardRemoval ? 0 : 16,
            );
            assert.equal(after.installations[0]!.wirePosts, 16);
            console.info("Controlled same-Document instrumentation replay", {
              browser: browser.version(),
              controlledDuplicateGuardRemoval,
              identity,
              before,
              after,
            });

            await page.evaluate(() =>
              Reflect.get(window, "pairedHost").releasePeer(),
            );
            await page.waitForFunction(
              () =>
                Reflect.get(window, "pairedHost").report().hostWires.length ===
                16,
            );
            const drained = await hostReport(page);
            assert.equal(drained.ready, 1);
            assert.deepEqual(drained.hostWires, [
              '{"type":"morphz-cognitive-ui/v1:connect"}',
              ...Array.from({ length: 15 }, (_, index) =>
                JSON.stringify(["duplicate-init", index]),
              ),
            ]);
            assert.deepEqual(
              drained.hostPosts.filter((packet) => packet.kind === "credit"),
              Array.from({ length: 16 }, (_, index) => ({
                kind: "credit",
                sequence: index + 1,
              })),
            );

            if (!controlledDuplicateGuardRemoval) {
              // Missing first-registration proof must fail, never install a new
              // hook after the production prefix captured its native methods.
              await frame.evaluate(() =>
                Reflect.deleteProperty(window, "pairedNativeGateRegistration"),
              );
              await assert.rejects(
                instrumentation.repeatInitScript(),
                /Fixture instrumentation installed too late/,
              );
              assert.equal(
                await frame.evaluate(
                  () =>
                    Reflect.get(window, "pairedPostBeforeRepeat") ===
                    MessagePort.prototype.postMessage,
                ),
                true,
              );
            }
          },
        );
      } finally {
        await browser.close();
      }
    },
  );
}

test(
  "CONTROLLED prefix harness: held native Document receive-start caps sixteen; actual callback credits reopen one window",
  { timeout: 30000 },
  async () => {
    const browser = await pairedBrowser();
    try {
      await withControlledPrefix(
        browser,
        { holdDocument: true },
        async (page, frame) => {
          await page.waitForFunction(
            () => Reflect.get(window, "pairedHost").report().ready === 1,
          );
          const held = await documentReport(frame);
          assert.equal(held.held, true);
          assert.equal(held.heldStarts, 1);
          assert.deepEqual(held.received, []);
          const burst = await page.evaluate(() => {
            const host = Reflect.get(window, "pairedHost");
            let sent = 0,
              rejected = 0;
            const codes: string[] = [];
            for (let index = 0; index < 1000; index++) {
              try {
                host.send(JSON.stringify(["host-held", index]));
                sent++;
              } catch (error) {
                rejected++;
                codes.push(Reflect.get(error as object, "code"));
              }
            }
            return { sent, rejected, codes };
          });
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
          assert.deepEqual((await documentReport(frame)).received, []);
          await frame.evaluate(() =>
            Reflect.get(window, "pairedNativeGate").release(),
          );
          await frame.waitForFunction(
            () =>
              Reflect.get(window, "pairedAuthor").report().received.length ===
              16,
          );
          const drained = await documentReport(frame);
          assert.equal(drained.held, false);
          assert.deepEqual(
            drained.received,
            Array.from({ length: 16 }, (_, index) =>
              JSON.stringify(["host-held", index]),
            ),
          );
          assert.deepEqual(
            drained.posts.filter((packet) => packet.kind === "credit"),
            Array.from({ length: 16 }, (_, index) => ({
              kind: "credit",
              sequence: index + 1,
            })),
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
              Reflect.get(window, "pairedAuthor").report().received.length ===
              32,
          );
          const final = await documentReport(frame);
          assert.deepEqual(
            final.received.slice(16),
            Array.from({ length: 16 }, (_, index) =>
              JSON.stringify(["host-resumed", index]),
            ),
          );
          assert.equal(
            final.received.includes(JSON.stringify(["host-held", 16])),
            false,
          );
          assert.equal(
            final.received.includes(JSON.stringify(["host-resumed", 16])),
            false,
          );
          assert.equal((await hostReport(page)).retired, 0);
        },
      );
    } finally {
      await browser.close();
    }
  },
);

for (const retiredGuardRemoval of [false, true])
  test(
    retiredGuardRemoval
      ? "CONTROLLED retired-only guard mutant: closed-port credit attempt is observable although the real Host receives none"
      : "CONTROLLED production prefix: callback disposal makes zero credit post attempts and leaves the Host window bounded",
    { timeout: 30000 },
    async () => {
      const browser = await pairedBrowser();
      try {
        await withControlledPrefix(
          browser,
          { controlledRetiredGuardRemoval: retiredGuardRemoval },
          async (page, frame) => {
            await page.waitForFunction(
              () => Reflect.get(window, "pairedHost").report().ready === 1,
            );
            await page.evaluate(() =>
              Reflect.get(window, "pairedHost").send(
                '"retire-during-callback"',
              ),
            );
            await frame.waitForFunction(
              () =>
                Reflect.get(window, "pairedAuthor").report().callbackRetired,
            );
            const document = await documentReport(frame);
            assert.deepEqual(document.received, ['"retire-during-callback"']);
            assert.deepEqual(
              document.posts.filter((packet) => packet.kind === "credit"),
              retiredGuardRemoval ? [{ kind: "credit", sequence: 1 }] : [],
            );
            assert.deepEqual(
              document.attempts.filter((packet) => packet.kind === "credit"),
              retiredGuardRemoval ? [{ kind: "credit", sequence: 1 }] : [],
            );
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
              (await documentReport(frame)).attempts.filter(
                (packet) => packet.kind === "credit",
              ),
              retiredGuardRemoval ? [{ kind: "credit", sequence: 1 }] : [],
            );
            assert.deepEqual(
              (await hostReport(page)).hostFrames.filter(
                (packet) => packet.kind === "credit",
              ),
              [],
            );
            // Neither close() nor unchanged callback counts claim browser queue GC.
          },
        );
      } finally {
        await browser.close();
      }
    },
  );
