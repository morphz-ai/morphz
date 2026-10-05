import assert from "node:assert/strict";
import test from "node:test";
import { openDocumentSdkFixture } from "./fixtures/cognitive-browser-document-sdk.js";

test(
  "ACTUAL packed Document-only SDK + shared prefix + native Chromium port: controlled Host, no SQL/production consumer/native App",
  { timeout: 180000 },
  async (t) => {
    const f = await openDocumentSdkFixture();
    t.after(() => f.close());
    await t.test(
      "packed SDK exposes all eight unchanged Browser v1 methods; exact original refs, immutable context and no Window business",
      async () => {
        const { page, guest } = await f.page();
        try {
          const inspect = await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").inspect(),
          );
          assert.equal(inspect.frozen, true);
          assert.equal(
            await guest.evaluate(() =>
              Reflect.get(window, "sdkFixture").shared(),
            ),
            true,
          );
          const object = {
            objectId: "原件/ 😀\n",
            versionRef: "v:opaque/first",
          };
          await guest.evaluate((object) => {
            const sdk = Reflect.get(window, "sdkFixture");
            for (const [key, method, args] of [
              ["ready", "ready", undefined],
              [
                "read",
                "invoke",
                {
                  operationId: "notes.read",
                  parameters: null,
                  resources: [],
                  commandId: null,
                },
              ],
              [
                "write",
                "invoke",
                {
                  operationId: "notes.write",
                  parameters: "original",
                  resources: [],
                  commandId: "original-write-id",
                },
              ],
              ["object", "readObject", { object, maxBytes: 100 }],
              ["open", "openObject", { object }],
              ["compose", "compose", { text: "引用", object }],
              [
                "state",
                "saveState",
                { expectedRevision: 1, state: { object, view: "reader" } },
              ],
              ["status", "commandStatus", "original-write-id"],
              ["recover", "recoverReceipt", "original-write-id"],
            ])
              sdk.run(key, method, args);
          }, object);
          await guest.waitForFunction(
            () =>
              Object.keys(Reflect.get(window, "sdkFixture").outcomes).length ===
              10,
          );
          const outcomes = await guest.evaluate(
            () => Reflect.get(window, "sdkFixture").outcomes,
          );
          for (const [key, value] of Object.entries(outcomes))
            assert.equal((value as { ok: boolean }).ok, true, key);
          assert.deepEqual(outcomes.object.value.object, object);
          assert.deepEqual(outcomes.state.value, {
            revision: 2,
            state: { object, view: "reader" },
          });
          assert.equal(
            outcomes.write.value.command.state,
            "unknown",
            "controlled facts are not a commit",
          );
          const report = await page.evaluate(
            () => Reflect.get(window, "sdkHost").report,
          );
          assert.equal(report.connects, 1);
          assert.equal(report.businessWindow, 0);
          assert.equal(report.requests.length, 9);
          assert.deepEqual(
            report.requests.map((item: { method: string }) => item.method),
            [
              "ready",
              "invoke",
              "invoke",
              "readObject",
              "openObject",
              "compose",
              "saveState",
              "commandStatus",
              "recoverReceipt",
            ],
          );
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "local Document retirement settles all already-sent SDK pending without another SDK call; original write commandId retained",
      { timeout: 20000 },
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
          await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.run("read", "invoke", {
              operationId: "notes.read",
              parameters: null,
              resources: [],
              commandId: null,
            });
            sdk.run("write", "invoke", {
              operationId: "notes.write",
              parameters: "original",
              resources: [],
              commandId: "original-write-id",
            });
          });
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 2,
          );
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").removeOriginal(),
          );
          try {
            await guest.waitForFunction(
              () =>
                Reflect.get(window, "sdkFixture").outcomes.read &&
                Reflect.get(window, "sdkFixture").outcomes.write,
              null,
              { timeout: 4000 },
            );
          } catch (error) {
            console.error("Native retirement pending witness", {
              originalReinserted: await guest.evaluate(() => ({
                root: document.documentElement !== null,
                doctype: document.doctype !== null,
                outcomes: Reflect.get(window, "sdkFixture").outcomes,
              })),
              actualHost: await page.evaluate(
                () => Reflect.get(window, "sdkHost").report,
              ),
            });
            throw error;
          }
          const outcomes = await guest.evaluate(
            () => Reflect.get(window, "sdkFixture").outcomes,
          );
          assert.equal(outcomes.read.code, "disposed");
          assert.equal(outcomes.write.code, "disposed");
          assert.equal(outcomes.write.commandId, "original-write-id");
          assert.equal(
            await guest.evaluate(() =>
              Reflect.get(window, "sdkFixture").timerCount(),
            ),
            0,
            "all local pending and connection timers were cancelled",
          );
          assert.equal(
            (
              await page.evaluate(
                () => Reflect.get(window, "sdkHost").report.requests,
              )
            ).length,
            2,
            "no automatic resend",
          );
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "root retirement while actual connect awaits controlled Host init rejects connection immediately and clears its local deadline",
      async () => {
        const { page, guest } = await f.page(true);
        try {
          assert.equal(
            await guest.evaluate(() =>
              Reflect.get(window, "sdkFixture").timerCount(),
            ),
            1,
          );
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").removeOriginal(),
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "sdkFixture").outcomes.connect !== undefined,
          );
          const outcome = await guest.evaluate(
            () => Reflect.get(window, "sdkFixture").outcomes.connect,
          );
          assert.equal(outcome.code, "disposed");
          assert.equal(
            await guest.evaluate(() =>
              Reflect.get(window, "sdkFixture").timerCount(),
            ),
            0,
          );
          const report = await page.evaluate(
            () => Reflect.get(window, "sdkHost").report,
          );
          assert.equal(report.peers, 1);
          assert.equal(report.connects, 1);
          assert.equal(report.sent.length, 0);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "real parent Window delivers valid forged init/response but actual Document-only SDK ignores both; only the private native response settles original pending",
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
          await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            addEventListener("message", () =>
              sdk.notifications.push("actual-window-message"),
            );
            sdk.run("original", "invoke", {
              operationId: "notes.read",
              parameters: null,
              resources: [],
              commandId: null,
            });
          });
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 1,
          );
          const report = await page.evaluate(
            () => Reflect.get(window, "sdkHost").report,
          );
          const wire = report.wires.find(
            (wire: { type: string }) =>
              wire.type === "morphz-cognitive-ui/v1:request",
          );
          const init = report.sent.find(
            (wire: { type: string }) =>
              wire.type === "morphz-cognitive-ui/v1:init",
          );
          const wrapper = page
            .frames()
            .find((frame) => frame.url().endsWith("/document"));
          assert.ok(wrapper);
          await wrapper.evaluate(
            ({ wire, init }) => {
              const inner = document.querySelector("iframe")!;
              inner.contentWindow!.postMessage(
                {
                  ...init,
                  context: {
                    ...init.context,
                    theme: { appearance: "light", accent: "coral" },
                  },
                },
                "*",
              );
              inner.contentWindow!.postMessage(
                {
                  type: "morphz-cognitive-ui/v1:response",
                  channel: wire.channel,
                  requestId: wire.requestId,
                  ok: true,
                  result: {
                    protocol: "morphz-domain/v1",
                    authority: init.context.authority,
                    operationId: "notes.read",
                    result: "FORGED-WINDOW-RESULT",
                  },
                },
                "*",
              );
            },
            { wire, init },
          );
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").notifications.length === 2,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes.original,
            ),
            undefined,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "sdkFixture").context().theme.accent,
            ),
            "iris",
          );
          await page.evaluate(() => Reflect.get(window, "sdkHost").release());
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.original,
          );
          assert.equal(
            await guest.evaluate(
              () =>
                Reflect.get(window, "sdkFixture").outcomes.original.value
                  .result,
            ),
            "PRIVATE-FIXTURE-RESULT",
          );
        } finally {
          await page.close();
        }
      },
    );
    for (const replacement of ["removeOriginal", "rewrite"] as const)
      await t.test(
        `${replacement}: context getter and subscription synchronously retire; same Document cannot reconnect; no peer-cancellation claim`,
        async () => {
          const { page, guest } = await f.page();
          try {
            const errors = await guest.evaluate((replacement) => {
              const sdk = Reflect.get(window, "sdkFixture");
              sdk[replacement]();
              const context = sdk.contextError(),
                observer = sdk.observeError();
              sdk.reconnect("again");
              sdk.run("after", "ready");
              return { context, observer };
            }, replacement);
            assert.deepEqual(errors, {
              context: "disposed",
              observer: "disposed",
            });
            await guest.waitForFunction(
              () =>
                Reflect.get(window, "sdkFixture").outcomes.again &&
                Reflect.get(window, "sdkFixture").outcomes.after,
            );
            const result = await guest.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes,
            );
            assert.equal(result.again.code, "disposed");
            assert.equal(result.after.code, "disposed");
            assert.equal(
              (
                await page.evaluate(
                  () => Reflect.get(window, "sdkHost").report.requests,
                )
              ).length,
              0,
            );
          } finally {
            await page.close();
          }
        },
      );
    await t.test(
      "original body reordering remains live; fresh Document connects after a different original retired",
      async () => {
        const first = await f.page();
        try {
          await first.guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.reorderBody();
            sdk.run("body", "ready");
          });
          await first.guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.body,
          );
          assert.equal(
            await first.guest.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes.body.ok,
            ),
            true,
          );
          await first.guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").removeOriginal(),
          );
          const fresh = await f.page();
          try {
            assert.equal(
              await fresh.guest.evaluate(
                () => Reflect.get(window, "sdkFixture").outcomes.connect.ok,
              ),
              true,
            );
          } finally {
            await fresh.page.close();
          }
        } finally {
          await first.page.close();
        }
      },
    );
    for (const seam of ["poisonParse", "poisonFreeze", "poisonClear"] as const)
      await t.test(
        `${seam}: rewrite during response processing rejects current parsing request and every other pending, not result disclosure`,
        async () => {
          const { page, guest } = await f.page();
          try {
            await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
            await guest.evaluate(() => {
              const sdk = Reflect.get(window, "sdkFixture");
              sdk.run("parsing", "invoke", {
                operationId: "notes.read",
                parameters: null,
                resources: [],
                commandId: null,
              });
              sdk.run("other", "invoke", {
                operationId: "notes.write",
                parameters: "private",
                resources: [],
                commandId: "pending-original",
              });
            });
            await page.waitForFunction(
              () => Reflect.get(window, "sdkHost").report.requests.length === 2,
            );
            await guest.evaluate(
              (seam) => Reflect.get(window, "sdkFixture")[seam](),
              seam,
            );
            await page.evaluate(() => Reflect.get(window, "sdkHost").release());
            await guest.waitForFunction(
              () =>
                Reflect.get(window, "sdkFixture").outcomes.parsing &&
                Reflect.get(window, "sdkFixture").outcomes.other,
            );
            const result = await guest.evaluate(() => ({
              outcomes: Reflect.get(window, "sdkFixture").outcomes,
              notifications: Reflect.get(window, "sdkFixture").notifications,
            }));
            assert.equal(result.outcomes.parsing.code, "disposed");
            assert.equal(result.outcomes.other.code, "disposed");
            assert.equal(result.outcomes.other.commandId, "pending-original");
            assert.deepEqual(
              result.notifications,
              seam === "poisonClear"
                ? ["timer-clear-rewrite", "disposed"]
                : [seam === "poisonParse" ? "parse-rewrite" : "freeze-rewrite"],
            );
            assert.equal(result.outcomes.parsing.value, undefined);
          } finally {
            await page.close();
          }
        },
      );
    await t.test(
      "request snapshot rewrite prevents admission; accessor inputs never execute getter",
      async () => {
        const { page, guest } = await f.page();
        try {
          assert.equal(
            await guest.evaluate(() =>
              Reflect.get(window, "sdkFixture").accessor(),
            ),
            0,
          );
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.accessor,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes.accessor.code,
            ),
            "invalid",
          );
          await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.poisonRequestSnapshot();
            sdk.run("snapshot", "invoke", {
              operationId: "notes.read",
              parameters: null,
              resources: [],
              commandId: null,
            });
          });
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.snapshot,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes.snapshot.code,
            ),
            "disposed",
          );
          assert.equal(
            (
              await page.evaluate(
                () => Reflect.get(window, "sdkHost").report.requests,
              )
            ).length,
            0,
          );
        } finally {
          await page.close();
        }
      },
    );
    for (const seam of ["poisonClear", "poisonClearExpiry"] as const)
      await t.test(
        `${seam}: real timer cleanup cannot accept currently settling original write after retirement or deadline; other original pending also settles`,
        async () => {
          const { page, guest } = await f.page();
          try {
            await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
            await guest.evaluate(() => {
              const sdk = Reflect.get(window, "sdkFixture");
              sdk.run("settling", "invoke", {
                operationId: "notes.write",
                parameters: "original",
                resources: [],
                commandId: "settling-original",
              });
              sdk.run("other", "invoke", {
                operationId: "notes.write",
                parameters: "original",
                resources: [],
                commandId: "other-original",
              });
            });
            await page.waitForFunction(
              () => Reflect.get(window, "sdkHost").report.requests.length === 2,
            );
            await guest.evaluate(
              (seam) => Reflect.get(window, "sdkFixture")[seam](),
              seam,
            );
            await page.evaluate(() => Reflect.get(window, "sdkHost").release());
            await guest.waitForFunction(
              () =>
                Reflect.get(window, "sdkFixture").outcomes.settling &&
                Reflect.get(window, "sdkFixture").outcomes.other,
            );
            const result = await guest.evaluate(() => ({
              outcomes: Reflect.get(window, "sdkFixture").outcomes,
              notifications: Reflect.get(window, "sdkFixture").notifications,
              timers: Reflect.get(window, "sdkFixture").timerCount(),
            }));
            console.info("Actual original write settle seam", seam, result);
            assert.equal(
              result.outcomes.settling.code,
              seam === "poisonClear" ? "disposed" : "timeout",
            );
            assert.equal(
              result.outcomes.settling.commandId,
              "settling-original",
            );
            assert.equal(
              result.outcomes.other.code,
              seam === "poisonClear" ? "disposed" : "timeout",
            );
            assert.equal(result.outcomes.other.commandId, "other-original");
            assert.equal(result.timers, 0);
            assert.deepEqual(
              result.notifications,
              seam === "poisonClear"
                ? ["timer-clear-rewrite", "disposed"]
                : ["timer-clear-expiry"],
            );
          } finally {
            await page.close();
          }
        },
      );
    await t.test(
      "actual native cleanup followed by author throw does not leak cause or strand original pending during explicit retirement",
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
          await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.run("one", "invoke", {
              operationId: "notes.write",
              parameters: "original",
              resources: [],
              commandId: "one-original",
            });
            sdk.run("two", "invoke", {
              operationId: "notes.write",
              parameters: "original",
              resources: [],
              commandId: "two-original",
            });
          });
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 2,
          );
          const thrown = await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.poisonClearThrow();
            try {
              sdk.dispose();
            } catch (error) {
              return (error as Error).message;
            }
            return null;
          });
          assert.equal(
            thrown,
            null,
            "cleanup must not expose an author's private throw",
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "sdkFixture").outcomes.one &&
              Reflect.get(window, "sdkFixture").outcomes.two,
          );
          const result = await guest.evaluate(() => ({
            outcomes: Reflect.get(window, "sdkFixture").outcomes,
            timers: Reflect.get(window, "sdkFixture").timerCount(),
          }));
          assert.equal(result.outcomes.one.code, "disposed");
          assert.equal(result.outcomes.one.commandId, "one-original");
          assert.equal(result.outcomes.two.code, "disposed");
          assert.equal(result.outcomes.two.commandId, "two-original");
          assert.equal(result.timers, 0);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "15 actual held pending with native credits positively consumed: UUID single reentry cannot send an outer 17th SDK request",
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
          await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.observeMark();
            sdk.directBurst(15);
          });
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 15,
          );
          await page.evaluate(() => Reflect.get(window, "sdkHost").update());
          await guest.waitForFunction(() =>
            Reflect.get(window, "sdkFixture").notifications.includes(
              "context-credit-barrier",
            ),
          );
          await guest.evaluate(() => {
            const sdk = Reflect.get(window, "sdkFixture");
            sdk.reenterUUID();
            sdk.run("outer", "invoke", {
              operationId: "notes.write",
              parameters: "unsent",
              resources: [],
              commandId: "budget-outer-original",
            });
          });
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.outer,
          );
          const result = await guest.evaluate(() => ({
            outcomes: Reflect.get(window, "sdkFixture").outcomes,
            notifications: Reflect.get(window, "sdkFixture").notifications,
            timers: Reflect.get(window, "sdkFixture").timerCount(),
          }));
          const report = await page.evaluate(
            () => Reflect.get(window, "sdkHost").report,
          );
          console.info(
            "Actual native credit barrier / reentry budget witness",
            result,
            report.wires.map((wire: { request?: unknown }) => wire.request),
          );
          assert.deepEqual(result.notifications, [
            "context-credit-barrier",
            "actual-native-uuid-reentry",
          ]);
          assert.equal(result.outcomes.outer.code, "busy");
          assert.equal(
            result.outcomes.outer.commandId,
            "budget-outer-original",
          );
          assert.equal(
            report.wires.filter(
              (wire: { request?: { commandId?: string } }) =>
                wire.request?.commandId === "budget-outer-original",
            ).length,
            0,
            "outer request must be rejected before private native wire send, not by Host's separate pending cap",
          );
          assert.equal(report.requests.length, 16);
          assert.equal(result.timers, 16);
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").dispose(),
          );
        } finally {
          await page.close();
        }
      },
    );
    for (const seam of ["poisonUUID", "poisonTimer"] as const)
      await t.test(
        `${seam}: actual allocation then synchronous original-root retirement settles newly allocating request as well as prior original write; no orphan timer/new RPC`,
        async () => {
          const { page, guest } = await f.page();
          try {
            await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
            await guest.evaluate(() =>
              Reflect.get(window, "sdkFixture").run("existing", "invoke", {
                operationId: "notes.write",
                parameters: "original",
                resources: [],
                commandId: "existing-allocation-original",
              }),
            );
            await page.waitForFunction(
              () => Reflect.get(window, "sdkHost").report.requests.length === 1,
            );
            await guest.evaluate((seam) => {
              const sdk = Reflect.get(window, "sdkFixture");
              sdk[seam]();
              sdk.run("allocating", "invoke", {
                operationId: "notes.write",
                parameters: "not sent",
                resources: [],
                commandId: "allocating-original",
              });
            }, seam);
            try {
              await guest.waitForFunction(
                () =>
                  Reflect.get(window, "sdkFixture").outcomes.existing &&
                  Reflect.get(window, "sdkFixture").outcomes.allocating,
              );
            } catch (error) {
              console.error(
                "Actual pending allocation retirement race",
                await guest.evaluate(() => ({
                  outcomes: Reflect.get(window, "sdkFixture").outcomes,
                  notifications: Reflect.get(window, "sdkFixture")
                    .notifications,
                  timers: Reflect.get(window, "sdkFixture").timerCount(),
                })),
                await page.evaluate(
                  () => Reflect.get(window, "sdkHost").report.requests,
                ),
              );
              throw error;
            }
            const result = await guest.evaluate(() => ({
              outcomes: Reflect.get(window, "sdkFixture").outcomes,
              notifications: Reflect.get(window, "sdkFixture").notifications,
              timers: Reflect.get(window, "sdkFixture").timerCount(),
            }));
            assert.deepEqual(result.notifications, [
              seam === "poisonUUID"
                ? "actual-native-uuid"
                : "actual-native-timer",
              "disposed",
            ]);
            assert.equal(result.outcomes.existing.code, "disposed");
            assert.equal(
              result.outcomes.existing.commandId,
              "existing-allocation-original",
            );
            assert.equal(result.outcomes.allocating.code, "disposed");
            assert.equal(
              result.outcomes.allocating.commandId,
              "allocating-original",
            );
            assert.equal(result.timers, 0);
            assert.equal(
              (
                await page.evaluate(
                  () => Reflect.get(window, "sdkHost").report.requests,
                )
              ).length,
              1,
            );
          } finally {
            await page.close();
          }
        },
      );
    for (const mode of ["observeRewrite", "observeThrow"] as const)
      await t.test(
        `${mode}: observers individually guarded; exceptions isolate but root rewrite stops next observer`,
        async () => {
          const { page, guest } = await f.page();
          try {
            await guest.evaluate(
              (mode) => Reflect.get(window, "sdkFixture")[mode](),
              mode,
            );
            await page.evaluate(() => Reflect.get(window, "sdkHost").update());
            await guest.waitForFunction(
              () => Reflect.get(window, "sdkFixture").notifications.length > 0,
            );
            await guest.evaluate(() => Promise.resolve());
            const result = await guest.evaluate(() => ({
              notifications: Reflect.get(window, "sdkFixture").notifications,
              error: Reflect.get(window, "sdkFixture").contextError(),
            }));
            assert.deepEqual(
              result.notifications,
              mode === "observeRewrite" ? ["first"] : ["first", "second"],
            );
            assert.equal(
              result.error,
              mode === "observeRewrite" ? "disposed" : "visible",
            );
          } finally {
            await page.close();
          }
        },
      );
    await t.test(
      "actual 16 native wire credits reject synchronous unsent follow-up with stable busy and original write ID; no queue/retry",
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => {
            const host = Reflect.get(window, "sdkHost");
            host.hold();
            host.early();
          });
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").burstFollow(),
          );
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.follow,
          );
          const result = await guest.evaluate(
            () => Reflect.get(window, "sdkFixture").outcomes.follow,
          );
          assert.equal(result.code, "busy");
          assert.equal(result.commandId, "native-busy-original");
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 16,
          );
          assert.equal(
            (
              await page.evaluate(
                () => Reflect.get(window, "sdkHost").report.requests,
              )
            ).filter(
              (request: { commandId?: string }) =>
                request.commandId === "native-busy-original",
            ).length,
            0,
          );
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "SDK 16 pending limit rejects 17th without native send; explicit disposal immediately settles every original pending",
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").directBurst(17),
          );
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 16,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes.burst16.code,
            ),
            "busy",
          );
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").dispose(),
          );
          await guest.waitForFunction(
            () =>
              Object.keys(Reflect.get(window, "sdkFixture").outcomes).length ===
              18,
          );
          const outcomes = await guest.evaluate(
            () => Reflect.get(window, "sdkFixture").outcomes,
          );
          for (let i = 0; i < 16; i++)
            assert.equal(outcomes[`burst${i}`].code, "disposed");
          assert.equal(
            (
              await page.evaluate(
                () => Reflect.get(window, "sdkHost").report.requests,
              )
            ).length,
            16,
          );
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "deadline crossed after real request admission rejects with original commandId; no implicit resend or cancellation of admitted business",
      async () => {
        const { page, guest } = await f.page();
        try {
          await page.evaluate(() => Reflect.get(window, "sdkHost").hold());
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").run("deadline", "invoke", {
              operationId: "notes.write",
              parameters: "original",
              resources: [],
              commandId: "deadline-original",
            }),
          );
          await page.waitForFunction(
            () => Reflect.get(window, "sdkHost").report.requests.length === 1,
          );
          await guest.evaluate(() =>
            Reflect.get(window, "sdkFixture").virtualExpiry(),
          );
          await page.evaluate(() => Reflect.get(window, "sdkHost").release());
          await guest.waitForFunction(
            () => Reflect.get(window, "sdkFixture").outcomes.deadline,
          );
          const result = await guest.evaluate(
            () => Reflect.get(window, "sdkFixture").outcomes.deadline,
          );
          assert.equal(result.code, "timeout");
          assert.equal(result.commandId, "deadline-original");
          assert.equal(
            (
              await page.evaluate(
                () => Reflect.get(window, "sdkHost").report.requests,
              )
            ).length,
            1,
          );
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      "no Document facade is unsupported even in real browser; no Window fallback post is attempted",
      async () => {
        const page = await f.unsupported();
        try {
          assert.equal(
            await page.evaluate(
              () => Reflect.get(window, "sdkFixture").outcomes.connect.code,
            ),
            "unsupported",
          );
          assert.equal(
            await page.evaluate(() => Reflect.get(window, "windowPosts")),
            0,
          );
        } finally {
          await page.close();
        }
      },
    );
  },
);
