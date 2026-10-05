import assert from "node:assert/strict";
import test from "node:test";
import { cognitiveDocumentBootstrapPolicy } from "../packages/application/src/cognitive-document-bootstrap.js";
import { applicationViewPermissions } from "../packages/core/src/resource-policy.js";
import { parseCognitiveAppViewResponse } from "../packages/core/src/cognitive-app-view-api.js";
import { openDocumentConsumerFixture } from "./fixtures/cognitive-document-consumer-mounted.js";

const presentation = {
  theme: { appearance: "light", accent: "coral" },
  presentation: { mode: "workspace", returnControl: null },
  active: true,
};

test(
  "ACTUAL Document consumer + packed SDK + authenticated dual SQL resource; business controlled, no production App/native owner",
  { timeout: 180000 },
  async (t) => {
    const f = await openDocumentConsumerFixture();
    t.after(() => f.close());
    for (const backend of ["sqlite", "postgres"] as const)
      await t.test(
        `${backend}: original authenticated document URL/header/native SDK handshake and controlled read`,
        async () => {
          await f.run(backend, async ({ page, guests, documentResponses }) => {
            const [guest] = await guests();
            assert.ok(guest);
            await guest.waitForFunction(
              () => Reflect.get(window, "consumerAuthor").connected,
            );
            assert.equal(documentResponses.length, 1);
            assert.equal(documentResponses[0]!.status, 200);
            assert.equal(
              documentResponses[0]!.csp,
              cognitiveDocumentBootstrapPolicy,
            );
            assert.equal(
              documentResponses[0]!.permissions,
              applicationViewPermissions,
            );
            const url = new URL(documentResponses[0]!.url);
            assert.match(
              url.pathname,
              /^\/api\/cognitive-app-document\/[A-Za-z0-9_-]+$/,
            );
            assert.deepEqual(
              [...url.searchParams.keys()],
              [
                "expectedViewRevision",
                "expectedBindingRevision",
                "documentProof",
              ],
            );
            await guest.evaluate(() =>
              Reflect.get(window, "consumerAuthor").run("read", "invoke", {
                operationId: "notes.list",
                parameters: null,
                resources: [],
                commandId: null,
              }),
            );
            await guest.waitForFunction(
              () => Reflect.get(window, "consumerAuthor").outcomes.read,
            );
            const outcome = await guest.evaluate(
              () => Reflect.get(window, "consumerAuthor").outcomes.read,
            );
            assert.equal(outcome.ok, true);
            assert.equal(outcome.value.result, "controlled business result");
            const report = await page.evaluate(
              () => Reflect.get(window, "consumerHost").report,
            );
            assert.deepEqual(report.ready, [true]);
            assert.equal(report.retired, 0);
            assert.equal(report.peers.length, 1);
            assert.equal(report.peers[0].label, "outer");
            assert.equal(report.peers[0].origin, page.url().replace(/\/$/, ""));
            assert.equal(report.observations[0].state, "loading");
            assert.equal(
              report.calls.filter(
                (value: { method: string }) =>
                  value.method === "cognitive-apps.invoke",
              ).length,
              1,
            );
          });
        },
      );
    await t.test(
      "save advances actual SQL CAS; presentation update preserves saved state and exact revision instead of reusing initial props",
      async () => {
        await f.run("sqlite", async ({ page, guests, transport }) => {
          const [guest] = await guests();
          assert.ok(guest);
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").connected,
          );
          const state = { view: "saved-reader" };
          await guest.evaluate(
            (state) =>
              Reflect.get(window, "consumerAuthor").run("saved", "saveState", {
                expectedRevision: 1,
                state,
              }),
            state,
          );
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").outcomes.saved,
          );
          assert.deepEqual(
            await guest.evaluate(
              () => Reflect.get(window, "consumerAuthor").outcomes.saved,
            ),
            { ok: true, value: { revision: 2, state } },
          );
          await page.evaluate(
            (presentation) =>
              Reflect.get(window, "consumerHost").update(presentation),
            presentation,
          );
          await guest.waitForFunction(() =>
            Reflect.get(window, "consumerAuthor").contexts.some(
              (context: { theme: { accent: string } }) =>
                context.theme.accent === "coral",
            ),
          );
          const context = await guest.evaluate(() =>
            Reflect.get(window, "consumerAuthor").context(),
          );
          assert.equal(context.view.revision, 2);
          assert.deepEqual(context.view.state, state);
          const actual = parseCognitiveAppViewResponse(
            "read",
            await transport.local.call(
              "cognitive-app-views.read",
              { viewId: context.view.id },
              { identityGeneration: transport.localCsrf },
            ),
          );
          assert.equal(actual.view.revision, 2);
          assert.deepEqual(actual.view.state, state);
          assert.equal(
            await page.evaluate(
              () => Reflect.get(window, "consumerHost").report.retired,
            ),
            0,
          );
          await page.evaluate(
            (presentation) =>
              Reflect.get(window, "consumerHost").update({
                ...presentation,
                active: false,
              }),
            presentation,
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "consumerAuthor").context().view.active ===
              false,
          );
          assert.deepEqual(
            await guest.evaluate(
              () => Reflect.get(window, "consumerAuthor").context().view.state,
            ),
            state,
          );
          assert.equal(
            await guest.evaluate(
              () =>
                Reflect.get(window, "consumerAuthor").context().view.revision,
            ),
            2,
          );
          await guest.evaluate(() =>
            Reflect.get(window, "consumerAuthor").run("hidden", "ready"),
          );
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").outcomes.hidden,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "consumerAuthor").outcomes.hidden.code,
            ),
            "forbidden",
          );
          await page.evaluate(
            (presentation) =>
              Reflect.get(window, "consumerHost").update(presentation),
            presentation,
          );
          await guest.waitForFunction(
            () =>
              Reflect.get(window, "consumerAuthor").context().view.active ===
              true,
          );
          await guest.evaluate(() =>
            Reflect.get(window, "consumerAuthor").run("resumed", "ready"),
          );
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").outcomes.resumed,
          );
          assert.equal(
            await guest.evaluate(
              () =>
                Reflect.get(window, "consumerAuthor").outcomes.resumed.value
                  .view.revision,
            ),
            2,
          );
        });
      },
    );
    await t.test(
      "actual parser-ready initializes packed SDK even when real outer load is positively witnessed and stopped before consumer",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests }) => {
            const [guest] = await guests();
            assert.ok(guest);
            await guest.waitForFunction(
              () => Reflect.get(window, "consumerAuthor").connected,
            );
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.loads === 1,
            );
            const report = await page.evaluate(
              () => Reflect.get(window, "consumerHost").report,
            );
            assert.deepEqual(report.ready, [true]);
            assert.equal(report.retired, 0);
            assert.equal(report.calls.length, 1);
            assert.equal(report.observations[0].state, "loading");
          },
          { suppressOuterLoad: true },
        );
      },
    );
    await t.test(
      "controlled denied initial channel authorization immediately retires uninitialized mount, not 30-second residual iframe",
      async () => {
        await f.run(
          "sqlite",
          async ({ page }) => {
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.calls.length > 0,
            );
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.retired === 1,
            );
            const state = await page.evaluate(() => ({
              report: Reflect.get(window, "consumerHost").report,
              frames: document.querySelectorAll("section>iframe").length,
            }));
            assert.equal(state.frames, 0);
            assert.deepEqual(state.report.ready, [false]);
            assert.equal(
              state.report.calls.some((value: { method: string }) =>
                value.method.startsWith("cognitive-apps."),
              ),
              false,
            );
          },
          { rejectAuthorize: true },
        );
      },
    );
    for (const backend of ["sqlite", "postgres"] as const)
      await t.test(
        `${backend}: actual Human grant withdrawal at held initial read-ui gate clears uninitialized mount without business calls`,
        async () => {
          await f.run(
            backend,
            async ({ page, guests, transport, callOutcomes }) => {
              await guests();
              await page.waitForFunction(
                () =>
                  Reflect.get(window, "consumerHost").report.calls.length === 1,
              );
              await transport.platform.changeCognitiveAppGrant(
                { credential: "setup-bob" },
                {
                  appId: transport.launch.appId,
                  version: transport.launch.version,
                  expectedRevision: 1,
                  state: "disabled",
                },
              );
              await page.evaluate(() =>
                Reflect.get(window, "consumerHost").release(),
              );
              await page.waitForFunction(
                () => Reflect.get(window, "consumerHost").report.retired === 1,
              );
              const state = await page.evaluate(() => ({
                frames: document.querySelectorAll("section>iframe").length,
                report: Reflect.get(window, "consumerHost").report,
                timers: Reflect.get(window, "consumerHost").timerCount(),
              }));
              assert.equal(state.frames, 0);
              assert.equal(state.timers, 0);
              assert.deepEqual(state.report.ready, [false]);
              assert.equal(state.report.calls.length, 1);
              assert.equal(callOutcomes.length, 1);
              assert.equal(callOutcomes[0]!.ok, false);
              assert.ok(
                ["forbidden", "not_found", "conflict"].includes(
                  callOutcomes[0]!.code!,
                ),
              );
            },
            { holdAuthorize: true },
          );
        },
      );
    await t.test(
      "owner abort clears every actual native Host timer even while controlled initial authorize deliberately ignores abort",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests }) => {
            await guests();
            await page.waitForFunction(
              () =>
                Reflect.get(window, "consumerHost").report.calls.length === 1,
            );
            await page.evaluate(() =>
              Reflect.get(window, "consumerHost").abort(),
            );
            const state = await page.evaluate(() => ({
              frames: document.querySelectorAll("section>iframe").length,
              report: Reflect.get(window, "consumerHost").report,
              timers: Reflect.get(window, "consumerHost").timerCount(),
            }));
            console.info(
              "Native timer cleanup witness while actual initial gate remains held",
              state,
            );
            assert.equal(state.frames, 0);
            assert.equal(state.report.retired, 1);
            assert.deepEqual(state.report.ready, [false]);
            assert.equal(state.timers, 0);
            await page.evaluate(() =>
              Reflect.get(window, "consumerHost").release(),
            );
          },
          { holdAuthorize: true },
        );
      },
    );
    await t.test(
      "actual opaque guest copies exact proof and transfers a native forged peer before held original outer peer: close attack, later admit original",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests }) => {
            const [guest] = await guests();
            assert.ok(guest);
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.held === 1,
            );
            const proof = await page.evaluate(
              () => Reflect.get(window, "consumerHost").proofs()[0],
            );
            await guest.evaluate(
              (proof) => Reflect.get(window, "consumerAuthor").forge(proof),
              proof,
            );
            await page.waitForFunction(() =>
              Reflect.get(window, "consumerHost").report.closed.includes(
                "foreign",
              ),
            );
            const before = await page.evaluate(
              () => Reflect.get(window, "consumerHost").report,
            );
            assert.equal(before.calls.length, 0);
            assert.deepEqual(before.ready, []);
            assert.equal(
              before.peers.some(
                (peer: { label: string; origin: string; proof: string }) =>
                  peer.label === "foreign" &&
                  peer.origin === "null" &&
                  peer.proof === proof,
              ),
              true,
            );
            assert.equal(
              await guest.evaluate(
                () => Reflect.get(window, "consumerAuthor").forgedSent,
              ),
              true,
            );
            await page.evaluate(() =>
              Reflect.get(window, "consumerHost").release(),
            );
            await guest.waitForFunction(
              () => Reflect.get(window, "consumerAuthor").connected,
            );
            await guest.evaluate(() =>
              Reflect.get(window, "consumerAuthor").run("original", "ready"),
            );
            await guest.waitForFunction(
              () => Reflect.get(window, "consumerAuthor").outcomes.original,
            );
            assert.equal(
              await guest.evaluate(
                () =>
                  Reflect.get(window, "consumerAuthor").outcomes.original.ok,
              ),
              true,
            );
            assert.equal(
              await guest.evaluate(
                () => Reflect.get(window, "consumerAuthor").outcomes.forged,
              ),
              undefined,
            );
          },
          { holdPeer: true },
        );
      },
    );
    await t.test(
      "actual own outer native peer with unknown data field is closed without consuming held strict original peer",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests }) => {
            const [guest] = await guests();
            assert.ok(guest);
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.held === 1,
            );
            const proof = await page.evaluate(
              () => Reflect.get(window, "consumerHost").proofs()[0],
            );
            const outer = guest.parentFrame()!;
            await outer.evaluate((proof) => {
              const channel = new MessageChannel();
              parent.postMessage(
                {
                  protocol: "morphz-cognitive-document-bootstrap/v2",
                  proof,
                  extra: "unknown",
                },
                "*",
                [channel.port2],
              );
              channel.port1.close();
            }, proof);
            await page.waitForFunction(() =>
              Reflect.get(window, "consumerHost").report.closed.includes(
                "outer",
              ),
            );
            assert.equal(
              await page.evaluate(
                () => Reflect.get(window, "consumerHost").report.calls.length,
              ),
              0,
            );
            await page.evaluate(() =>
              Reflect.get(window, "consumerHost").release(),
            );
            await guest.waitForFunction(
              () => Reflect.get(window, "consumerAuthor").connected,
            );
            assert.deepEqual(
              await page.evaluate(
                () => Reflect.get(window, "consumerHost").report.ready,
              ),
              [true],
            );
          },
          { holdPeer: true },
        );
      },
    );
    await t.test(
      "two concurrent consumers keep different proofs and do not close another mount's legitimate transferred peer",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests, documentResponses }) => {
            const frames = await guests();
            assert.equal(frames.length, 2);
            for (const guest of frames)
              await guest.waitForFunction(
                () => Reflect.get(window, "consumerAuthor").connected,
              );
            const state = await page.evaluate(() => ({
              proofs: Reflect.get(window, "consumerHost").proofs(),
              report: Reflect.get(window, "consumerHost").report,
            }));
            assert.equal(new Set(state.proofs).size, 2);
            assert.deepEqual(state.report.ready, [true, true]);
            assert.equal(state.report.closed.length, 0);
            assert.equal(state.report.retired, 0);
            assert.equal(documentResponses.length, 2);
            for (const guest of frames) {
              await guest.evaluate(() =>
                Reflect.get(window, "consumerAuthor").run("own", "ready"),
              );
              await guest.waitForFunction(
                () => Reflect.get(window, "consumerAuthor").outcomes.own,
              );
              assert.equal(
                await guest.evaluate(
                  () => Reflect.get(window, "consumerAuthor").outcomes.own.ok,
                ),
                true,
              );
            }
          },
          { count: 2 },
        );
      },
    );
    await t.test(
      "ordinary author body/CSS updates preserve original Document and native SDK endpoint; no remount or Host CSS changes",
      async () => {
        await f.run("sqlite", async ({ page, guests, documentResponses }) => {
          const [guest] = await guests();
          assert.ok(guest);
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").connected,
          );
          const proof = await page.evaluate(
            () => Reflect.get(window, "consumerHost").proofs()[0],
          );
          await guest.evaluate(() => {
            Reflect.get(window, "consumerAuthor").normalDOM();
            Reflect.get(window, "consumerAuthor").run("ordinary", "ready");
          });
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").outcomes.ordinary,
          );
          assert.equal(
            await guest.evaluate(
              () => Reflect.get(window, "consumerAuthor").outcomes.ordinary.ok,
            ),
            true,
          );
          assert.equal(
            await page.evaluate(
              () => Reflect.get(window, "consumerHost").proofs()[0],
            ),
            proof,
          );
          assert.equal(
            await page.evaluate(
              () => Reflect.get(window, "consumerHost").report.retired,
            ),
            0,
          );
          assert.equal(documentResponses.length, 1);
          assert.deepEqual(
            await page.evaluate(() => ({
              styles: document.querySelectorAll("style,link[rel=stylesheet]")
                .length,
              inline: document
                .querySelector("section>iframe")
                ?.getAttribute("style"),
            })),
            { styles: 0, inline: null },
          );
        });
      },
    );
    await t.test(
      "owner abort during held business retires once, aborts original signal and suppresses late return without replacement RPC",
      async () => {
        await f.run("sqlite", async ({ page, guests }) => {
          const [guest] = await guests();
          assert.ok(guest);
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").connected,
          );
          await page.evaluate(() => Reflect.get(window, "consumerHost").hold());
          await guest.evaluate(() =>
            Reflect.get(window, "consumerAuthor").run("held", "invoke", {
              operationId: "notes.list",
              parameters: null,
              resources: [],
              commandId: null,
            }),
          );
          await page.waitForFunction(() =>
            Reflect.get(window, "consumerHost").report.calls.some(
              (call: { method: string }) =>
                call.method === "cognitive-apps.invoke",
            ),
          );
          await page.evaluate(() => {
            Reflect.get(window, "consumerHost").abort();
            Reflect.get(window, "consumerHost").retire();
          });
          const count = await page.evaluate(
            () => Reflect.get(window, "consumerHost").report.calls.length,
          );
          await page.evaluate(() =>
            Reflect.get(window, "consumerHost").release(),
          );
          await page.waitForFunction(
            () => Reflect.get(window, "consumerHost").timerCount() === 0,
          );
          const state = await page.evaluate(() => ({
            report: Reflect.get(window, "consumerHost").report,
            frames: document.querySelectorAll("section>iframe").length,
          }));
          assert.equal(state.frames, 0);
          assert.equal(state.report.retired, 1);
          assert.equal(state.report.aborts, 1);
          assert.equal(state.report.calls.length, count);
          assert.deepEqual(
            state.report.ready,
            [true],
            "initial ready is not a live lease",
          );
        });
      },
    );
    await t.test(
      "owner generation becomes false during awaited initial gate: no init or business, immediate late-result cleanup",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests }) => {
            await guests();
            await page.waitForFunction(
              () =>
                Reflect.get(window, "consumerHost").report.calls.length === 1,
            );
            await page.evaluate(() => {
              Reflect.get(window, "consumerHost").ownerGone();
              Reflect.get(window, "consumerHost").release();
            });
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.retired === 1,
            );
            const state = await page.evaluate(() => ({
              report: Reflect.get(window, "consumerHost").report,
              frames: document.querySelectorAll("section>iframe").length,
            }));
            assert.equal(state.frames, 0);
            assert.deepEqual(state.report.ready, [false]);
            assert.equal(state.report.calls.length, 1);
            assert.equal(state.report.closed.includes("outer"), true);
          },
          { holdAuthorize: true },
        );
      },
    );
    await t.test(
      "initial invalid owner does not mount/fetch/bridge and settles ready false once",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, documentResponses }) => {
            const state = await page.evaluate(() => ({
              report: Reflect.get(window, "consumerHost").report,
              frames: document.querySelectorAll("section>iframe").length,
              timers: Reflect.get(window, "consumerHost").timerCount(),
            }));
            assert.equal(state.frames, 0);
            assert.equal(state.timers, 0);
            assert.equal(state.report.retired, 1);
            assert.equal(state.report.calls.length, 0);
            assert.deepEqual(state.report.ready, [false]);
            assert.equal(documentResponses.length, 0);
          },
          { initiallyCurrent: false },
        );
      },
    );
    await t.test(
      "real owner signal aborts synchronously inside current callback returning stale true: no post-retirement mount/timer resurrection",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, documentResponses }) => {
            const state = await page.evaluate(() => ({
              report: Reflect.get(window, "consumerHost").report,
              frames: document.querySelectorAll("section>iframe").length,
              timers: Reflect.get(window, "consumerHost").timerCount(),
            }));
            console.info("Actual reentrant AbortSignal mount witness", state);
            assert.equal(state.frames, 0);
            assert.equal(state.timers, 0);
            assert.equal(state.report.retired, 1);
            assert.equal(state.report.calls.length, 0);
            assert.deepEqual(state.report.ready, [false]);
            assert.equal(documentResponses.length, 0);
          },
          { abortInsideCurrent: true },
        );
      },
    );
    await t.test(
      "peer/parser-ready are not enough: initial authorize returning past absolute mount deadline cannot publish init",
      async () => {
        await f.run(
          "sqlite",
          async ({ page, guests }) => {
            await guests();
            await page.waitForFunction(
              () =>
                Reflect.get(window, "consumerHost").report.calls.length === 1,
            );
            await page.evaluate(() => {
              Reflect.get(window, "consumerHost").virtualExpire();
              Reflect.get(window, "consumerHost").release();
            });
            await page.waitForFunction(
              () => Reflect.get(window, "consumerHost").report.retired === 1,
            );
            const state = await page.evaluate(() => ({
              frames: document.querySelectorAll("section>iframe").length,
              report: Reflect.get(window, "consumerHost").report,
              timers: Reflect.get(window, "consumerHost").timerCount(),
            }));
            assert.equal(state.frames, 0);
            assert.deepEqual(state.report.ready, [false]);
            assert.equal(state.report.calls.length, 1);
            assert.equal(state.timers, 0);
          },
          { holdAuthorize: true },
        );
      },
    );
    for (const action of ["relocate", "reinsert", "virtualExpire"] as const)
      await t.test(
        `held actual native original peer after ${action} cannot attach a new channel or disclose init`,
        async () => {
          await f.run(
            "sqlite",
            async ({ page, guests }) => {
              await guests();
              await page.waitForFunction(
                () => Reflect.get(window, "consumerHost").report.held === 1,
              );
              await page.evaluate((action) => {
                Reflect.get(window, "consumerHost")[action]();
                Reflect.get(window, "consumerHost").release();
              }, action);
              if (action === "reinsert")
                assert.equal(
                  await page.evaluate(
                    () =>
                      Reflect.get(window, "consumerHost").report
                        .reinsertDifferent,
                  ),
                  true,
                );
              try {
                await page.waitForFunction(
                  () =>
                    Reflect.get(window, "consumerHost").report.retired === 1,
                );
              } catch (error) {
                console.error(
                  "Actual mount identity and held native peer witness",
                  action,
                  await page.evaluate(
                    () => Reflect.get(window, "consumerHost").report,
                  ),
                );
                throw error;
              }
              const state = await page.evaluate(() => ({
                report: Reflect.get(window, "consumerHost").report,
                frames: document.querySelectorAll("section>iframe").length,
                timers: Reflect.get(window, "consumerHost").timerCount(),
              }));
              assert.equal(state.frames, 0);
              assert.equal(state.timers, 0);
              assert.deepEqual(state.report.ready, [false]);
              assert.equal(state.report.calls.length, 0);
              assert.equal(state.report.closed.length > 0, true);
              if (action === "reinsert")
                assert.equal(state.report.reinsertDifferent, true);
            },
            { holdPeer: true, suppressOuterLoad: action === "reinsert" },
          );
        },
      );
    await t.test(
      "actual second outer resource navigation retires original mount instead of bridging replacement Document",
      async () => {
        await f.run("sqlite", async ({ page, guests, documentResponses }) => {
          const [guest] = await guests();
          assert.ok(guest);
          await guest.waitForFunction(
            () => Reflect.get(window, "consumerAuthor").connected,
          );
          const originalGates = await page.evaluate(
            () => Reflect.get(window, "consumerHost").report.calls.length,
          );
          const outer = guest.parentFrame()!;
          await outer.goto(outer.url()).catch((error: unknown) => {
            assert.match(
              String(error),
              /detached|removed|aborted|ERR_ABORTED/i,
            );
          });
          await page.waitForFunction(
            () => Reflect.get(window, "consumerHost").report.retired === 1,
          );
          const state = await page.evaluate(() => ({
            report: Reflect.get(window, "consumerHost").report,
            frames: document.querySelectorAll("section>iframe").length,
          }));
          assert.equal(documentResponses.length, 2);
          assert.equal(state.frames, 0);
          assert.deepEqual(state.report.ready, [true]);
          assert.equal(state.report.calls.length, originalGates);
        });
      },
    );
  },
);
