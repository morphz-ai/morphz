import assert from "node:assert/strict";
import test from "node:test";
import type { Frame, Page } from "@playwright/test";
import {
  createCognitiveDocumentBootstrap,
  cognitiveDocumentFacadeName,
} from "../apps/web/src/host/cognitive-document-bootstrap.js";
import { parseWireJson } from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  authorDocument,
  documentBootstrapReport,
  prepareDocumentBootstrapBrowser,
  withDocumentBootstrap,
} from "./fixtures/cognitive-document-bootstrap-mounted.js";

async function original(page: Page): Promise<Frame> {
  await page.waitForFunction(() =>
    Reflect.get(window, "documentBootstrapHost")
      .report()
      .observations.some(
        (value: { type?: string; kind?: string }) =>
          value.type === "delivered" && value.kind === "init",
      ),
  );
  const frame = page.frames().find((item) => item.url() === "about:srcdoc");
  assert.ok(frame, "Actual opaque srcdoc exists.");
  return frame;
}
async function host(page: Page, method: string, parameter?: unknown) {
  await page.evaluate(
    ({ method, parameter }) =>
      Reflect.get(window, "documentBootstrapHost")[method](parameter),
    { method, parameter },
  );
}
async function request(frame: Frame, id: string) {
  await frame.evaluate(
    (id) => Reflect.get(window, "documentSdkStub").request(id),
    id,
  );
}
async function settle(page: Page) {
  // A bounded two-frame turn boundary, not a claim that close clears queues.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
function results(
  report: Awaited<ReturnType<typeof documentBootstrapReport>>,
  id: string,
) {
  return report.observations.filter(
    (item) =>
      item.type === "delivered" && item.kind === "result" && item.id === id,
  );
}

function javascriptRewriteAuthor(): string {
  const replacement =
    '<!doctype html><html><body><main id="replacement">REAL JAVASCRIPT REWRITE</main></body></html>';
  const javascriptURL =
    'javascript:top.postMessage({fixtureObservation:{type:"javascript-executing"}},"*");document.open();document.write(' +
    JSON.stringify(replacement) +
    ');document.close();(()=>{const rejected=[];for(const [name,action] of [["check",()=>window.documentSdkStub.check()],["send",()=>window.documentSdkStub.request("javascript-after-rewrite")],["subscribe",()=>window.documentSdkStub.subscribe(()=>undefined)],["factory",()=>window.__morphzCognitiveDocument()]]){try{action()}catch(error){rejected.push({name,message:error.message})}}top.postMessage({fixtureObservation:{type:"javascript-synchronous-guard",rejected}},"*")})();void 0';
  return authorDocument(
    "",
    `const anchor=document.createElement("a");anchor.id="javascript-rewrite-link";anchor.textContent="真实 JavaScript URL 重写";anchor.href=${JSON.stringify(javascriptURL)};anchor.addEventListener("click",()=>top.postMessage({fixtureObservation:{type:"javascript-link-real-click"}},"*"));document.body.append(anchor);window.originalJavascriptDocument=document;window.originalJavascriptRoot=document.documentElement;`,
  );
}

async function javascriptDocumentIdentity(frame: Frame) {
  return frame.evaluate(() => ({
    sameDocument:
      Reflect.get(window, "originalJavascriptDocument") === document,
    sameRoot:
      Reflect.get(window, "originalJavascriptRoot") ===
      document.documentElement,
    original: !!document.getElementById("original"),
    replacement: !!document.getElementById("replacement"),
    origin: location.origin,
    parentAccess: (() => {
      try {
        return !!parent.document;
      } catch {
        return false;
      }
    })(),
    href: document.querySelector<HTMLAnchorElement>("#javascript-rewrite-link")
      ?.href,
  }));
}

test("Document prototype: exact UTF-8 bytes/SHA and scalar ingress (no author source interpolation)", async () => {
  const author =
    '\uFEFF<!doctype html><html><body>中文 😀 </script><script>window.marker="作者"</script></body></html>';
  const resource = await createCognitiveDocumentBootstrap(
    author,
    "fixed_proof_for_isolated_test_1234",
  );
  assert.deepEqual(resource.authorBytes, new TextEncoder().encode(author));
  assert.equal(resource.authorSha256.length, 64);
  assert.equal(resource.html.includes(author), false);
  assert.match(resource.html, /frame|iframe/);
  await assert.rejects(
    createCognitiveDocumentBootstrap(
      "\ud800",
      "fixed_proof_for_isolated_test_1234",
    ),
  );
  await assert.rejects(
    createCognitiveDocumentBootstrap("", "fixed_proof_for_isolated_test_1234"),
  );
  await assert.rejects(createCognitiveDocumentBootstrap("ok", "</script>"));
  let read = 0;
  await assert.rejects(
    createCognitiveDocumentBootstrap(
      {
        toString() {
          read++;
          return "HTML";
        },
        toJSON() {
          read++;
          return "HTML";
        },
      } as unknown as string,
      "fixed_proof_for_isolated_test_1234",
    ),
  );
  assert.equal(read, 0);
});

test(
  "Isolated actual Chromium Document handoff, controlled synchronous SDK/Host only; no SQL/native/business/production consumer",
  { timeout: 180_000 },
  async (t) => {
    const browser = await prepareDocumentBootstrapBrowser();
    t.after(() => browser.close());

    await t.test(
      "real header CSP, opaque original, prefix first, private parser-ready, normal body rearrange",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(
            "window.prefixWasFirst = typeof window.__morphzCognitiveDocument === 'function';",
          ),
          {},
          async (page, evidence) => {
            const frame = await original(page);
            assert.equal(
              await frame.evaluate(() => Reflect.get(window, "prefixWasFirst")),
              true,
            );
            const state = await frame.evaluate(() => ({
              origin: location.origin,
              parentAccess: (() => {
                try {
                  return !!parent.document;
                } catch {
                  return false;
                }
              })(),
              node: document.documentElement.nodeName,
              doctype: document.doctype?.name,
              fixed:
                Object.getOwnPropertyDescriptor(
                  window,
                  "__morphzCognitiveDocument",
                )?.configurable === false,
            }));
            assert.equal(state.parentAccess, false);
            assert.equal(state.node, "HTML");
            assert.equal(state.doctype, "html");
            assert.equal(state.fixed, true);
            const wrapperResponse = await page.request.get(
              new URL("/trusted-wrapper", page.url()).href,
            );
            assert.equal(
              wrapperResponse.headers()["content-security-policy"],
              evidence.wrapperPolicy,
            );
            const mainResponse = await page.request.get(page.url());
            assert.match(
              mainResponse.headers()["content-security-policy"]!,
              /script-src 'self' 'wasm-unsafe-eval'/,
            );
            assert.doesNotMatch(
              mainResponse.headers()["content-security-policy"]!,
              /script-src[^;]*'unsafe-inline'/,
            );
            await frame.evaluate(() => {
              const root = document.documentElement;
              root.setAttribute("data-normal", "yes");
              document.body.replaceChildren(
                Object.assign(document.createElement("main"), {
                  textContent: "normal body replacement",
                }),
              );
              document.body.prepend(document.createElement("aside"));
              Reflect.get(window, "documentSdkStub").check();
            });
            await request(frame, "normal");
            await page.waitForFunction(() =>
              Reflect.get(window, "documentBootstrapHost")
                .report()
                .observations.some(
                  (value: { id?: string }) => value.id === "normal",
                ),
            );
            const report = await documentBootstrapReport(page);
            assert.equal(report.peers, 1);
            assert.equal(report.ready, 1);
            assert.equal(report.requests.length, 1);
            assert.equal(results(report, "normal")[0]?.marker, evidence.marker);
            assert.equal(
              report.observations.some(
                (value) => value.type === "sensitive-window-message",
              ),
              false,
            );
          },
        );
      },
    );

    await t.test(
      "original full HTML/BOM/non-ASCII author bytes survive browser decoding; normal inline style and body work",
      async () => {
        const author =
          "\uFEFF" +
          authorDocument("", 'document.body.style.color="rgb(12, 34, 56)";');
        await withDocumentBootstrap(
          browser,
          author,
          {},
          async (page, evidence) => {
            const frame = await original(page);
            assert.equal(
              await frame.evaluate(() => getComputedStyle(document.body).color),
              "rgb(12, 34, 56)",
            );
            assert.equal(
              await frame.locator("#original").textContent(),
              "原作者 😀",
            );
            const wrapper = page
              .frames()
              .find((frame) => frame.url().endsWith("/trusted-wrapper"));
            assert.ok(wrapper);
            const decoded = await wrapper.evaluate(async () => {
              const script = document.querySelector("script")!.textContent!;
              const payload = /atob\("([A-Za-z0-9+/=]+)"\)/.exec(script)![1]!;
              const binary = atob(payload),
                bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++)
                bytes[i] = binary.charCodeAt(i);
              return {
                text: new TextDecoder("utf-8", {
                  fatal: true,
                  ignoreBOM: true,
                }).decode(bytes),
                sha: Array.from(
                  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                  (byte) => byte.toString(16).padStart(2, "0"),
                ).join(""),
              };
            });
            assert.equal(decoded.text, author);
            assert.equal(decoded.sha, evidence.originalSha256);
            assert.deepEqual(
              evidence.originalBytes,
              new TextEncoder().encode(author),
            );
          },
        );
      },
    );

    for (const method of [
      "open-write-close",
      "remove-root-reinsert",
      "remove-doctype-reinsert",
    ] as const) {
      await t.test(
        `${method}: synchronous egress/subscribe/factory retire, original node reinsertion never resurrects`,
        async () => {
          await withDocumentBootstrap(
            browser,
            authorDocument(),
            {},
            async (page) => {
              const frame = await original(page);
              const outcome = await frame.evaluate((method) => {
                const sdk = Reflect.get(window, "documentSdkStub"),
                  root = document.documentElement,
                  doctype = document.doctype!;
                if (method === "open-write-close") {
                  document.open();
                  document.write(
                    '<!doctype html><html><body><main id="replacement">actual document.write replacement</main></body></html>',
                  );
                  document.close();
                } else if (method === "remove-root-reinsert") {
                  root.remove();
                  document.append(root);
                } else {
                  doctype.remove();
                  document.insertBefore(doctype, root);
                }
                const rejected: string[] = [];
                for (const [name, action] of [
                  [
                    "send",
                    () =>
                      sdk.send(
                        '{"kind":"request","method":"readObject","id":"after-rewrite"}',
                      ),
                  ],
                  ["subscribe", () => sdk.subscribe(() => undefined)],
                  [
                    "factory",
                    () => Reflect.get(window, "__morphzCognitiveDocument")(),
                  ],
                ] as const) {
                  try {
                    action();
                  } catch {
                    rejected.push(name);
                  }
                }
                return rejected;
              }, method);
              assert.deepEqual(outcome, ["send", "subscribe", "factory"]);
              await settle(page);
              assert.equal(
                (await documentBootstrapReport(page)).requests.length,
                0,
              );
            },
          );
        },
      );
    }

    await t.test(
      "CONTROLLED RED witness: omitting synchronous takeRecords leaks after same-turn original root reinsertion",
      async () => {
        const seam = "records(apply(take, observer, []));";
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {
            mutate(html) {
              // Prefix is a JSON literal in outer HTML; replace exactly this reviewed seam.
              assert.equal(html.split(seam).length, 2);
              return html.replace(
                seam,
                "/* CONTROLLED MUTANT: sync takeRecords removed */",
              );
            },
          },
          async (page, evidence) => {
            const frame = await original(page);
            await frame.evaluate(() => {
              const root = document.documentElement;
              root.remove();
              document.append(root);
              Reflect.get(window, "documentSdkStub").request("controlled-red");
            });
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost").report().requests
                  .length === 1,
            );
            const report = await documentBootstrapReport(page);
            assert.equal(report.requests[0]?.id, "controlled-red");
            // The witness is old capability egress, not a claim that a slow body leaked.
            assert.equal(report.sent[0]?.marker, evidence.marker);
          },
        );
      },
    );

    await t.test(
      "CONTROLLED navigation-permitted header: actual before-first-load replacement/prefix-before-parent peer cannot inherit init",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument('location.replace("/replacement?before-first-load");'),
          { holdPeer: true, controlledNavigationPolicy: true },
          async (page, evidence) => {
            await page
              .waitForFunction(() =>
                Reflect.get(window, "documentBootstrapHost")
                  .report()
                  .observations.some(
                    (item: { type?: string }) =>
                      item.type === "replacement-executing",
                  ),
              )
              .catch((error: unknown) => {
                console.error(
                  "ACTUAL first-load navigation diagnostics",
                  evidence.console,
                  evidence.paths,
                );
                throw error;
              });
            const before = await documentBootstrapReport(page);
            assert.equal(before.peers, 1);
            assert.equal(before.ready, 0);
            await host(page, "releasePeer");
            await settle(page);
            const report = await documentBootstrapReport(page);
            assert.equal(report.peers, 1);
            assert.equal(
              report.observations.some(
                (item) =>
                  item.type === "delivered" && item.document === "replacement",
              ),
              false,
            );
            assert.equal(
              report.observations.some(
                (item) => item.type === "claim-rejected",
              ),
              true,
            );
          },
        );
      },
    );

    await t.test(
      "fixed real header blocks network self-navigation (not a replacement-handoff witness)",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument('location.replace("/replacement?fixed-csp");'),
          {},
          async (page, evidence) => {
            await settle(page);
            assert.ok(
              evidence.console.some(
                (line) =>
                  line.includes("frame-src 'none'") && line.includes("blocked"),
              ),
              "Real Chromium CSP rejection is required.",
            );
            assert.equal(
              evidence.paths.some((path) => path.startsWith("/replacement")),
              false,
            );
            assert.equal(
              (await documentBootstrapReport(page)).observations.some(
                (item) => item.type === "replacement-executing",
              ),
              false,
            );
            // CSP may commit its browser error document; no assertion invents an author replacement.
          },
        );
      },
    );

    await t.test(
      "private parser-ready cannot be forged through facade wire before parser finishes",
      async () => {
        const early = `const f=window.__morphzCognitiveDocument();f.send('{"kind":"parser-ready"}');top.postMessage({fixtureObservation:{type:"early-factory"}},"*");`;
        await withDocumentBootstrap(
          browser,
          authorDocument(early),
          {},
          async (page) => {
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost").report().ready ===
                1,
            );
            const report = await documentBootstrapReport(page);
            assert.equal(report.ready, 1);
            assert.equal(report.requests.length, 0);
            assert.equal(report.invalid, 1);
            assert.equal(
              report.observations.some(
                (item) => item.type === "claim-rejected",
              ),
              true,
            );
          },
        );
      },
    );

    await t.test(
      "slow Host body reply after doc.open cannot publish; rewriting page actually runs",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {},
          async (page, evidence) => {
            const frame = await original(page);
            await host(page, "holdReplies", true);
            await request(frame, "slow-old");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost").report().requests
                  .length === 1,
            );
            await frame.evaluate(() => {
              document.open();
              document.write(
                '<!doctype html><html><body><main id="replacement">rewritten</main><script>top.postMessage({fixtureObservation:{type:"replacement-executing"}},"*")<\/script></body></html>',
              );
              document.close();
            });
            await page.waitForFunction(() =>
              Reflect.get(window, "documentBootstrapHost")
                .report()
                .observations.some(
                  (item: { type?: string }) =>
                    item.type === "replacement-executing",
                ),
            );
            await host(page, "releaseReplies");
            await settle(page);
            const report = await documentBootstrapReport(page);
            assert.equal(
              report.sent.some(
                (item) =>
                  item.kind === "result" && item.marker === evidence.marker,
              ),
              true,
            );
            assert.equal(results(report, "slow-old").length, 0);
          },
        );
      },
    );

    for (const sandbox of [null, "allow-scripts allow-same-origin"] as const)
      await t.test(
        `CONTROLLED JavaScript URL guard witness: same script/native click/header, ${sandbox === null ? "only sandbox removed" : "only allow-same-origin added"}; actual script-start, root replacement and same-script synchronous guard required`,
        async () => {
          await withDocumentBootstrap(
            browser,
            javascriptRewriteAuthor(),
            {
              mutate(html) {
                const seam = 'inner.sandbox = "allow-scripts";';
                assert.equal(html.split(seam).length, 2);
                return html.replace(
                  seam,
                  sandbox === null
                    ? "/* CONTROLLED positive control: no inner sandbox */"
                    : `inner.sandbox = ${JSON.stringify(sandbox)}; /* CONTROLLED positive control */`,
                );
              },
            },
            async (page, evidence) => {
              const wrapper = page
                .frames()
                .find((frame) => frame.url().endsWith("/trusted-wrapper"));
              assert.ok(wrapper);
              await wrapper.locator("iframe").waitFor();
              const frame = wrapper
                .childFrames()
                .find((item) => item.url() === "about:srcdoc");
              assert.ok(frame);
              await frame.locator("#javascript-rewrite-link").click();
              await page.waitForFunction(
                () =>
                  Reflect.get(window, "documentBootstrapHost")
                    .report()
                    .observations.some(
                      (item: { type?: string }) =>
                        item.type === "javascript-executing",
                    ),
                undefined,
                { timeout: 10_000 },
              );
              await frame.waitForFunction(
                () =>
                  document.querySelector("#replacement")?.textContent ===
                  "REAL JAVASCRIPT REWRITE",
                undefined,
                { timeout: 10_000 },
              );
              const identity = await javascriptDocumentIdentity(frame);
              console.info("ACTUAL JavaScript URL positive control", {
                browser: browser.version(),
                sandbox,
                identity,
                policy: evidence.wrapperPolicy,
                report: await documentBootstrapReport(page),
                console: evidence.console,
                paths: evidence.paths,
              });
              assert.equal(identity.sameDocument, true);
              assert.equal(identity.sameRoot, false);
              assert.equal(identity.original, false);
              assert.equal(identity.replacement, true);
              // No Host authority/init: this proves only the native local guard mechanism.
              const report = await documentBootstrapReport(page);
              assert.equal(report.peers, 0);
              assert.deepEqual(
                report.observations.find(
                  (item) => item.type === "javascript-synchronous-guard",
                )?.rejected,
                ["check", "send", "subscribe", "factory"].map((name) => ({
                  name,
                  message: "Cognitive document is retired.",
                })),
              );
              assert.equal(report.requests.length, 0);
              assert.equal(report.sent.length, 0);
            },
          );
        },
      );

    await t.test(
      "actual opaque sandbox JavaScript URL mechanism diagnostic: browser prevented execution, not rewrite-isolation witness; actual click/original root/current peer survive",
      async () => {
        await withDocumentBootstrap(
          browser,
          javascriptRewriteAuthor(),
          {},
          async (page, evidence) => {
            const frame = await original(page);
            await host(page, "holdReplies", true);
            await request(frame, "javascript-old");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost").report().requests
                  .length === 1,
            );
            await frame.locator("#javascript-rewrite-link").click();
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost")
                  .report()
                  .observations.some(
                    (item: { type?: string }) =>
                      item.type === "javascript-link-real-click",
                  ),
              undefined,
              { timeout: 10_000 },
            );
            await settle(page);
            const report = await documentBootstrapReport(page),
              identity = await javascriptDocumentIdentity(frame);
            console.info(
              "ACTUAL opaque JavaScript URL nonexecution diagnostic (not rewrite isolation)",
              {
                browser: browser.version(),
                policy: evidence.wrapperPolicy,
                identity,
                report,
                console: evidence.console,
                paths: evidence.paths,
              },
            );
            assert.equal(
              report.observations.some(
                (item) => item.type === "javascript-executing",
              ),
              false,
            );
            assert.equal(
              report.observations.some(
                (item) => item.type === "javascript-synchronous-guard",
              ),
              false,
            );
            assert.equal(identity.sameDocument, true);
            assert.equal(identity.sameRoot, true);
            assert.equal(identity.original, true);
            assert.equal(identity.replacement, false);
            assert.equal(identity.parentAccess, false);
            assert.equal(report.peers, 1);
            assert.equal(report.ready, 1);
            assert.equal(
              report.observations.find(
                (item) => item.type === "javascript-link-real-click",
              )?.eventOrigin,
              "null",
            );
            await frame.evaluate(() =>
              Reflect.get(window, "documentSdkStub").check(),
            );
            await host(page, "releaseReplies");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost")
                  .report()
                  .observations.some(
                    (item: { kind?: string; id?: string }) =>
                      item.kind === "result" && item.id === "javascript-old",
                  ),
              undefined,
              { timeout: 10_000 },
            );
            const result = results(
              await documentBootstrapReport(page),
              "javascript-old",
            );
            assert.equal(result.length, 1);
            assert.equal(result[0]?.document, "original");
            assert.equal(result[0]?.marker, evidence.marker);
          },
        );
      },
    );

    await t.test(
      "captured native record/nodeList/document/observer/JSON/port methods survive author prototype poisoning",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {},
          async (page) => {
            const frame = await original(page);
            const rejected = await frame.evaluate(String.raw`(() => {
              const sdk=window.documentSdkStub, root=document.documentElement, doctype=document.doctype;
              const define=Object.defineProperty;
              define(MutationRecord.prototype,"removedNodes",{configurable:true,get:()=>({length:0})});
              define(MutationRecord.prototype,"target",{configurable:true,get:()=>null});
              define(NodeList.prototype,"length",{configurable:true,get:()=>0});
              NodeList.prototype.item=()=>null;
              MutationObserver.prototype.takeRecords=()=>[];
              MutationObserver.prototype.disconnect=()=>undefined;
              define(Document.prototype,"documentElement",{configurable:true,get:()=>root});
              define(Document.prototype,"doctype",{configurable:true,get:()=>doctype});
              MessagePort.prototype.postMessage=()=>{throw Error("poison post")};
              JSON.parse=()=>({kind:"fake"});Object.keys=()=>[];Reflect.apply=()=>{throw Error("poison apply")};
              TextEncoder.prototype.encode=()=>new Uint8Array(0);
              root.remove();document.append(root);
              try {sdk.send('{"kind":"request","method":"readObject","id":"poison-old"}');return false} catch{return true}
            })()`);
            assert.equal(rejected, true);
            await settle(page);
            assert.equal(
              (await documentBootstrapReport(page)).requests.length,
              0,
            );
          },
        );
      },
    );

    await t.test(
      "port/event data/JSON prototype poison without root removal does not redirect normal send or response",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {},
          async (page, evidence) => {
            const frame = await original(page);
            await frame.evaluate(String.raw`(() => {
              MessagePort.prototype.postMessage=()=>{throw Error("poison post")};
              Object.defineProperty(MessageEvent.prototype,"data",{configurable:true,get:()=>({kind:"wire",text:'{"kind":"result","id":"poison-normal","marker":"FAKE"}'})});
              JSON.parse=()=>({kind:"result",marker:"FAKE"});
              window.documentSdkStub.send('{"kind":"request","method":"readObject","id":"poison-normal"}');
            })()`);
            await page.waitForFunction(() =>
              Reflect.get(window, "documentBootstrapHost")
                .report()
                .observations.some(
                  (item: { id?: string }) => item.id === "poison-normal",
                ),
            );
            assert.equal(
              results(await documentBootstrapReport(page), "poison-normal")[0]
                ?.marker,
              evidence.marker,
            );
          },
        );
      },
    );

    await t.test(
      "copy proof/second peer/late old peer cannot replace the one private endpoint",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {},
          async (page, evidence) => {
            const frame = await original(page);
            await frame.evaluate(
              ({ proof, protocol }) => {
                const channel = new MessageChannel();
                channel.port1.onmessage = (event) =>
                  top?.postMessage(
                    {
                      fixtureObservation: {
                        type: "second-peer-body",
                        value: event.data,
                      },
                    },
                    "*",
                  );
                parent.postMessage({ protocol, proof }, "*", [channel.port2]);
                top?.postMessage({ protocol, proof }, "*", [
                  new MessageChannel().port2,
                ]);
              },
              {
                proof: evidence.proof,
                protocol: "morphz-cognitive-document-bootstrap/v1",
              },
            );
            await request(frame, "still-original");
            await page.waitForFunction(
              () =>
                Reflect.get(window, "documentBootstrapHost").report().requests
                  .length === 1,
            );
            await settle(page);
            const report = await documentBootstrapReport(page);
            assert.equal(report.peers, 1);
            assert.equal(
              report.observations.some(
                (item) => item.type === "second-peer-body",
              ),
              false,
            );
            assert.equal(
              results(report, "still-original")[0]?.marker,
              evidence.marker,
            );
            await host(page, "retire");
            await request(frame, "late-after-host-close");
            await settle(page);
            assert.equal(
              (await documentBootstrapReport(page)).requests.length,
              1,
            );
          },
        );
      },
    );

    await t.test(
      "wire framing oracle preserves existing 512KiB/40depth/32768node budgets and rejects nontext before accessors",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {},
          async (page) => {
            const frame = await original(page);
            const within = { a: "x".repeat(300_000) };
            parseWireJson(within);
            const depth: unknown = Array.from({ length: 39 }).reduce<unknown>(
              (value) => [value],
              null,
            );
            parseWireJson(depth);
            await frame.evaluate(
              ({ within, depth }) => {
                const sdk = Reflect.get(window, "documentSdkStub");
                sdk.send(JSON.stringify(within));
                sdk.send(JSON.stringify(depth));
              },
              { within, depth },
            );
            assert.throws(() => parseWireJson({ a: "x".repeat(524_288) }));
            const rejected = await frame.evaluate(() => {
              const sdk = Reflect.get(window, "documentSdkStub");
              let invoked = 0,
                rejected = 0;
              const carrier = {
                get value() {
                  invoked++;
                  return "secret";
                },
                toJSON() {
                  invoked++;
                  return "secret";
                },
              };
              let deep: unknown = null;
              for (let i = 0; i < 40; i++) deep = [deep];
              for (const input of [
                carrier,
                '"' + "😀".repeat(140000) + '"',
                JSON.stringify(deep),
                JSON.stringify(Array(32768).fill(null)),
                "1e999",
              ]) {
                try {
                  sdk.send(input);
                } catch {
                  rejected++;
                }
              }
              return { rejected, invoked };
            });
            assert.deepEqual(rejected, { rejected: 5, invoked: 0 });
            assert.equal(
              (await documentBootstrapReport(page)).requests.length,
              0,
            );
          },
        );
      },
    );

    await t.test(
      "fixed facade disposal is sticky and cannot be configured or re-minted",
      async () => {
        await withDocumentBootstrap(
          browser,
          authorDocument(),
          {},
          async (page) => {
            const frame = await original(page);
            const outcome = await frame.evaluate((name) => {
              const sdk = Reflect.get(window, "documentSdkStub");
              const definition = Object.getOwnPropertyDescriptor(window, name)!;
              let reconfigure = false;
              try {
                Object.defineProperty(window, name, { value: () => undefined });
              } catch {
                reconfigure = true;
              }
              sdk.dispose();
              let rejected = false;
              try {
                sdk.send(
                  '{"kind":"request","method":"readObject","id":"disposed"}',
                );
              } catch {
                rejected = true;
              }
              return {
                reconfigure,
                rejected,
                writable: definition.writable,
                configurable: definition.configurable,
              };
            }, cognitiveDocumentFacadeName);
            assert.deepEqual(outcome, {
              reconfigure: true,
              rejected: true,
              writable: false,
              configurable: false,
            });
            await host(page, "emit", {
              kind: "result",
              id: "disposed",
              marker: "CONTROLLED",
            });
            await settle(page);
            assert.equal(
              results(await documentBootstrapReport(page), "disposed").length,
              0,
            );
          },
        );
      },
    );
  },
);
