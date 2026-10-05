import assert from "node:assert/strict";
import test from "node:test";
import {
  authorDocument,
  documentBootstrapReport,
  prepareDocumentBootstrapBrowser,
  withDocumentBootstrap,
} from "./fixtures/cognitive-document-bootstrap-mounted.js";

const subscriber = String.raw`(() => {
  const facade = window.__morphzCognitiveDocument();
  let retired = 0;
  facade.subscribe(() => {}, () => {
    retired++;
    throw Error("PRIVATE author cleanup failure");
  });
  window.retirementHarness = {
    check() { facade.check(); },
    send(text) { facade.send(text); },
    dispose() { facade.dispose(); },
    report() { return retired; }
  };
  top.postMessage({fixtureObservation:{type:"retirement-subscriber-claimed"}},"*");
})();`;

for (const synchronous of [true, false])
  test(`ACTUAL Chromium: original root/doctype removal and reinsertion retires its local subscriber exactly once ${synchronous ? "synchronously at check" : "via native MutationObserver without another API call"}`, async () => {
    const browser = await prepareDocumentBootstrapBrowser();
    try {
      await withDocumentBootstrap(
        browser,
        authorDocument(subscriber),
        {},
        async (page, evidence) => {
          await page.waitForFunction(() =>
            Reflect.get(window, "documentBootstrapHost")
              .report()
              .observations.some(
                (item: any) => item.type === "retirement-subscriber-claimed",
              ),
          );
          const frame = page
            .frames()
            .find((candidate) => candidate.url() === "about:srcdoc");
          assert.ok(frame);
          const result = await frame.evaluate(async (synchronous) => {
            const harness = Reflect.get(window, "retirementHarness");
            const root = document.documentElement,
              doctype = document.doctype!;
            root.remove();
            doctype.remove();
            document.append(doctype, root);
            let denied = false;
            if (synchronous) {
              try {
                harness.check();
              } catch {
                denied = true;
              }
            } else {
              // Native MutationObserver notification, not a second SDK/guard API.
              await Promise.resolve();
            }
            const beforeDispose = harness.report();
            harness.dispose();
            harness.dispose();
            return {
              denied,
              beforeDispose,
              afterDispose: harness.report(),
              original: !!document.getElementById("original"),
            };
          }, synchronous);
          assert.deepEqual(result, {
            denied: synchronous,
            beforeDispose: 1,
            afterDispose: 1,
            original: true,
          });
          const send = await frame.evaluate(() => {
            try {
              Reflect.get(window, "retirementHarness").send('"old"');
              return "sent";
            } catch (error) {
              return String(error);
            }
          });
          assert.match(send, /retired/);
          assert.equal(
            (await documentBootstrapReport(page)).requests.length,
            0,
          );
          assert.equal(
            evidence.console.some((item) =>
              item.includes("PRIVATE author cleanup"),
            ),
            false,
          );
        },
      );
    } finally {
      await browser.close();
    }
  });

test("ACTUAL Chromium: full native window returns a captured readonly busy code without retiring or queueing the local facade", async () => {
  const browser = await prepareDocumentBootstrapBrowser();
  try {
    await withDocumentBootstrap(
      browser,
      authorDocument(subscriber),
      { holdPeer: true },
      async (page) => {
        await page.waitForFunction(() =>
          Reflect.get(window, "documentBootstrapHost")
            .report()
            .observations.some(
              (item: any) => item.type === "retirement-subscriber-claimed",
            ),
        );
        const frame = page
          .frames()
          .find((candidate) => candidate.url() === "about:srcdoc");
        assert.ok(frame);
        const result = await frame.evaluate(() => {
          const harness = Reflect.get(window, "retirementHarness");
          for (let index = 0; index < 16; index++)
            harness.send(JSON.stringify(index));
          try {
            harness.send('"not-sent"');
            throw Error("Unexpected send");
          } catch (error) {
            harness.check();
            const descriptor = Object.getOwnPropertyDescriptor(error, "code");
            return {
              code: descriptor?.value,
              writable: descriptor?.writable,
              configurable: descriptor?.configurable,
              retired: harness.report(),
            };
          }
        });
        assert.deepEqual(result, {
          code: "busy",
          writable: false,
          configurable: false,
          retired: 0,
        });
        assert.equal((await documentBootstrapReport(page)).ready, 0);
      },
    );
  } finally {
    await browser.close();
  }
});
