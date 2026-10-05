import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import {
  authorDocument,
  documentBootstrapReport,
  prepareDocumentBootstrapBrowser,
  withDocumentBootstrap,
} from "./fixtures/cognitive-document-bootstrap-mounted.js";

async function authorFrame(page: Page) {
  await page.waitForFunction(() =>
    Reflect.get(window, "documentBootstrapHost")
      .report()
      .observations.some((item: any) => item.type === "stub-claimed"),
  );
  const frame = page
    .frames()
    .find((candidate) => candidate.url() === "about:srcdoc");
  assert.ok(frame);
  return frame;
}

async function deliveredBarrier(page: Page, id: string) {
  await page.evaluate((id) => {
    const host = Reflect.get(window, "documentBootstrapHost");
    host.emit({ kind: "result", id, marker: host.marker });
  }, id);
  await page.waitForFunction(
    (id) =>
      Reflect.get(window, "documentBootstrapHost")
        .report()
        .observations.some(
          (item: any) => item.type === "delivered" && item.id === id,
        ),
    id,
  );
}

test("ACTUAL Chromium: native wire egress is bounded even when author bypasses SDK pending and Host peer is held", async () => {
  const browser = await prepareDocumentBootstrapBrowser();
  try {
    await withDocumentBootstrap(
      browser,
      authorDocument(),
      { holdPeer: true },
      async (page) => {
        await page.waitForFunction(() =>
          Reflect.get(window, "documentBootstrapHost")
            .report()
            .observations.some((item: any) => item.type === "stub-claimed"),
        );
        const frame = page
          .frames()
          .find((candidate) => candidate.url() === "about:srcdoc");
        assert.ok(frame);
        const burst = await frame.evaluate(() => {
          const stub = Reflect.get(window, "documentSdkStub");
          let sent = 0,
            rejected = 0;
          for (let index = 0; index < 1_000; index++) {
            try {
              stub.request(`burst_${index}`);
              sent++;
            } catch {
              rejected++;
            }
          }
          return { sent, rejected };
        });
        assert.deepEqual(burst, { sent: 16, rejected: 984 });
        assert.equal((await documentBootstrapReport(page)).ready, 0);
        await page.evaluate(() =>
          Reflect.get(window, "documentBootstrapHost").releasePeer(),
        );
        await page.waitForFunction(
          () =>
            Reflect.get(window, "documentBootstrapHost").report().requests
              .length === 16,
        );
        const report = await documentBootstrapReport(page);
        assert.equal(report.requests.length, 16);
        assert.equal(
          report.requests.some((request) => request.id === "burst_16"),
          false,
        );
        // The controlled peer posted all sixteen credits before this wire. Its
        // positive delivery is a FIFO barrier, not a sleep or exposed counter.
        await deliveredBarrier(page, "credit-consumed-barrier");
        await frame.evaluate(() =>
          Reflect.get(window, "documentSdkStub").request(
            "explicit-after-credit",
          ),
        );
        await page.waitForFunction(
          () =>
            Reflect.get(window, "documentBootstrapHost").report().requests
              .length === 17,
        );
        const recovered = await documentBootstrapReport(page);
        assert.deepEqual(
          recovered.requests.map((request) => request.id),
          [
            ...Array.from({ length: 16 }, (_, index) => `burst_${index}`),
            "explicit-after-credit",
          ],
        );
        assert.equal(recovered.invalid, 0);
      },
    );
  } finally {
    await browser.close();
  }
});

test("ACTUAL Chromium: duplicate native credit retires the original document instead of opening another send slot", async () => {
  const browser = await prepareDocumentBootstrapBrowser();
  try {
    await withDocumentBootstrap(browser, authorDocument(), {}, async (page) => {
      const frame = await authorFrame(page);
      await page.waitForFunction(
        () => Reflect.get(window, "documentBootstrapHost").report().ready === 1,
      );
      await frame.evaluate(() =>
        Reflect.get(window, "documentSdkStub").request("one-original-request"),
      );
      await page.waitForFunction(
        () =>
          Reflect.get(window, "documentBootstrapHost").report().requests
            .length === 1,
      );
      await deliveredBarrier(page, "credit-one-consumed");
      await page.evaluate(() =>
        Reflect.get(window, "documentBootstrapHost").packet({
          kind: "credit",
          sequence: 1,
        }),
      );
      await frame.waitForFunction(() => {
        try {
          Reflect.get(window, "documentSdkStub").check();
          return false;
        } catch {
          return true;
        }
      });
      const result = await frame.evaluate(() => {
        try {
          Reflect.get(window, "documentSdkStub").request(
            "replayed-credit-request",
          );
          return "sent";
        } catch (error) {
          return String(error);
        }
      });
      assert.match(result, /retired/);
      assert.deepEqual((await documentBootstrapReport(page)).requests, [
        { id: "one-original-request", method: "readObject" },
      ]);
    });
  } finally {
    await browser.close();
  }
});

for (const mutant of [false, true])
  test(`ACTUAL Chromium ${mutant ? "CONTROLLED array-guard-removal mutant" : "production"}: array-shaped native wire ${mutant ? "reaches the author (positive attack oracle)" : "retires without author delivery"}`, async () => {
    const browser = await prepareDocumentBootstrapBrowser();
    try {
      await withDocumentBootstrap(
        browser,
        authorDocument(),
        {
          mutate: mutant
            ? (html) => {
                const seam = " || array(message) || keys(message).length !== 2";
                assert.equal(
                  html.split(seam).length,
                  2,
                  "Exactly one production array guard seam.",
                );
                return html.replace(seam, " || keys(message).length !== 2");
              }
            : undefined,
        },
        async (page) => {
          const frame = await authorFrame(page);
          await deliveredBarrier(page, "array-attack-ready");
          await page.evaluate(() => {
            const host = Reflect.get(window, "documentBootstrapHost");
            host.packet(
              Object.assign([], {
                kind: "wire",
                text: JSON.stringify({
                  kind: "result",
                  id: "array-forgery",
                  marker: host.marker,
                }),
              }),
            );
          });
          if (mutant) {
            await page.waitForFunction(() =>
              Reflect.get(window, "documentBootstrapHost")
                .report()
                .observations.some(
                  (item: any) =>
                    item.type === "delivered" && item.id === "array-forgery",
                ),
            );
            await frame.evaluate(() =>
              Reflect.get(window, "documentSdkStub").check(),
            );
          } else {
            await frame.waitForFunction(() => {
              try {
                Reflect.get(window, "documentSdkStub").check();
                return false;
              } catch {
                return true;
              }
            });
            assert.equal(
              (await documentBootstrapReport(page)).observations.some(
                (item) =>
                  item.type === "delivered" && item.id === "array-forgery",
              ),
              false,
            );
          }
        },
      );
    } finally {
      await browser.close();
    }
  });

const rewriteSubscriber = String.raw`(() => {
  const facade = window.__morphzCognitiveDocument();
  const post = top.postMessage.bind(top), parse = JSON.parse;
  window.creditHarness = { check() { facade.check(); } };
  facade.subscribe(text => {
    const value = parse(text);
    if (value.id === "rewrite-on-delivery") {
      document.open();
      document.write("<!doctype html><html><body><main id='replacement'>实际重写</main></body></html>");
      document.close();
      post({fixtureObservation:{type:"actual-rewrite-on-delivery"}},"*");
    } else post({fixtureObservation:{type:"original-credit-subscriber",id:value.id}},"*");
  });
  post({fixtureObservation:{type:"credit-subscriber-claimed"}},"*");
})();`;

for (const mutant of [false, true])
  test(`ACTUAL Chromium ${mutant ? "CONTROLLED post-callback-guard-removal mutant" : "production"}: synchronous document.open inside subscriber ${mutant ? "incorrectly posts a second credit (positive oracle)" : "retires before a second credit"}`, async () => {
    const browser = await prepareDocumentBootstrapBrowser();
    try {
      await withDocumentBootstrap(
        browser,
        authorDocument(rewriteSubscriber),
        {
          mutate: mutant
            ? (html) => {
                // The prefix is JSON-escaped inside the immutable wrapper's
                // srcdoc literal. This only removes the one encoded guard call.
                const seam = String.raw`if (ready && subscriber !== null) subscriber(validated);\n      check();`;
                assert.equal(
                  html.split(seam).length,
                  2,
                  "Exactly one post-callback guard seam.",
                );
                return html.replace(
                  seam,
                  "if (ready && subscriber !== null) subscriber(validated);",
                );
              }
            : undefined,
        },
        async (page) => {
          await page.waitForFunction(
            () =>
              Reflect.get(window, "documentBootstrapHost").report().credits
                .length === 1,
          );
          assert.deepEqual((await documentBootstrapReport(page)).credits, [1]);
          const frame = page
            .frames()
            .find((candidate) => candidate.url() === "about:srcdoc");
          assert.ok(frame);
          await page.evaluate(() => {
            const host = Reflect.get(window, "documentBootstrapHost");
            host.emit({
              kind: "result",
              id: "rewrite-on-delivery",
              marker: host.marker,
            });
          });
          await page.waitForFunction(() =>
            Reflect.get(window, "documentBootstrapHost")
              .report()
              .observations.some(
                (item: any) => item.type === "actual-rewrite-on-delivery",
              ),
          );
          assert.equal(
            await frame.locator("#replacement").innerText(),
            "实际重写",
          );
          await frame.waitForFunction(() => {
            try {
              Reflect.get(window, "creditHarness").check();
              return false;
            } catch {
              return true;
            }
          });
          if (mutant) {
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost").report().credits
                  .length === 2,
            );
            assert.deepEqual(
              (await documentBootstrapReport(page)).credits,
              [1, 2],
            );
          } else {
            assert.deepEqual(
              (await documentBootstrapReport(page)).credits,
              [1],
            );
          }
        },
      );
    } finally {
      await browser.close();
    }
  });
