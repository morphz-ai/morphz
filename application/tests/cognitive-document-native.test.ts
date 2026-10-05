import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { _electron, expect, type ElectronApplication } from "@playwright/test";
import {
  cognitiveAppDocumentResourcePath,
  cognitiveAppDocumentResourceMime,
} from "../packages/core/src/cognitive-app-document-resource.js";
import { applicationViewPermissions } from "../packages/core/src/resource-policy.js";
import {
  cognitiveDocumentBootstrapProtocol,
  cognitiveDocumentBootstrapPolicy,
  createCognitiveDocumentBootstrap,
} from "../packages/application/src/cognitive-document-bootstrap.js";

test(
  "ACTUAL isolated Electron production scheme/adapter and native Document origins; controlled typed document port/Host, not SQL, production SDK or original user window",
  { timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(
      resolve(tmpdir(), "morphz-embedded-electron-"),
    );
    const isolated = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:MORPHZ_|MORPHZWORK_|DOUBAO_|OPENAI_|ANTHROPIC_|AZURE_)/.test(
            key,
          ),
      ),
    );
    delete isolated.ELECTRON_RUN_AS_NODE;
    let electron: ElectronApplication | undefined;
    t.after(async () => {
      try {
        if (electron) {
          try {
            await electron.evaluate(() =>
              Reflect.get(
                globalThis,
                "__cognitiveDocumentNativeFixture",
              )?.retire(),
            );
          } finally {
            await electron.close();
          }
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
    electron = await _electron.launch({
      args: [resolve("tests/fixtures/cognitive-document-native-entry.cjs")],
      env: {
        ...isolated,
        MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
        MORPHZ_APP_ENV_FILE: "",
      },
      timeout: 30000,
    });
    // The real main may first create an inert hidden legacy-preference reader.
    // It is not the owning window and closes normally after the read attempt.
    await expect
      .poll(
        () =>
          electron!.windows().some((page) => page.url() === "morphz://app/"),
        {
          timeout: 30000,
        },
      )
      .toBe(true);
    const owner = electron
      .windows()
      .find((page) => page.url() === "morphz://app/")!;
    await owner.getByRole("region", { name: "认知应用工作空间" }).waitFor();
    assert.equal(
      await electron.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (window) => window.webContents.getURL() === "morphz://app/",
          ).length,
      ),
      1,
      "the actual production main owns exactly one native application window",
    );
    assert.equal(
      await owner.evaluate(() => typeof Reflect.get(window, "require")),
      "undefined",
    );
    assert.equal(await owner.evaluate(() => isSecureContext), true);
    const errors: string[] = [];
    owner.on("pageerror", (error) => errors.push(error.message));
    const proof = "native_document_proof_01234567890123456789";
    const author = `\uFEFF<!doctype html><html><head><meta charset="utf-8"></head><body><p id="native-original">原生作者原文 😀</p><script>
  const facade = window.__morphzCognitiveDocument();
  let secondClaimDenied = false;
  try { window.__morphzCognitiveDocument(); } catch { secondClaimDenied = true; }
  const inspection = {
    type: "author-inspection",
    node: typeof require,
    bridge: typeof window.morphzDesktop,
    parentDOM: (() => { try { return !!parent.document; } catch { return false; } })(),
    ownerDOM: (() => { try { return !!top.document; } catch { return false; } })(),
    secondClaimDenied,
    facadeKeys: Object.keys(facade),
    original: document.getElementById("native-original").textContent,
  };
  facade.subscribe((text) => {
    const packet = JSON.parse(text);
    facade.send(JSON.stringify({type: "delivered", kind: packet.kind, marker: packet.marker}));
  });
  facade.send(JSON.stringify(inspection));
  top.postMessage({nativeAuthorOriginProbe: true}, "*");
  const forged = new MessageChannel();
  top.postMessage({protocol: ${JSON.stringify(cognitiveDocumentBootstrapProtocol)}, proof: ${JSON.stringify(proof)}}, "*", [forged.port2]);
  </script></body></html>`;
    const expected = await createCognitiveDocumentBootstrap(author, proof);
    const metadata = await electron.evaluate(
      async (_, input) =>
        Reflect.get(globalThis, "__cognitiveDocumentNativeFixture").configure(
          input.author,
          input.proof,
        ),
      { author, proof },
    );
    assert.equal(
      metadata.protocol,
      cognitiveDocumentBootstrapProtocol,
      "compiled production builder must match current source protocol",
    );
    assert.equal(metadata.policy, cognitiveDocumentBootstrapPolicy);
    assert.equal(
      metadata.authorSha256,
      createHash("sha256")
        .update(new TextEncoder().encode(author))
        .digest("hex"),
    );
    const path = cognitiveAppDocumentResourcePath(metadata.request);
    const documents = await owner.evaluate(async (path) => {
      const results = [];
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(path, { method });
        results.push({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          bytes: [...new Uint8Array(await response.arrayBuffer())],
        });
      }
      return results;
    }, path);
    for (let index = 0; index < documents.length; index++) {
      const value = documents[index]!;
      assert.equal(value.status, 200);
      assert.equal(
        value.headers["content-type"],
        cognitiveAppDocumentResourceMime,
      );
      assert.equal(
        value.headers["content-length"],
        String(expected.bytes.byteLength),
      );
      assert.equal(
        value.headers["content-security-policy"],
        cognitiveDocumentBootstrapPolicy,
      );
      assert.equal(
        value.headers["permissions-policy"],
        applicationViewPermissions,
      );
      assert.equal(value.headers["cache-control"], "no-store");
      assert.equal(value.headers["x-content-type-options"], "nosniff");
      assert.deepEqual(
        new Uint8Array(value.bytes),
        index === 1 ? new Uint8Array() : expected.bytes,
      );
    }
    await owner.evaluate(
      ({ path, proof, protocol }) => {
        const carrier = document.createElement("iframe");
        carrier.id = "native-document-carrier";
        carrier.title = "隔离自动化文档机制验收";
        carrier.style.cssText =
          "position:fixed;left:320px;top:100px;width:780px;height:480px;border:0;z-index:100";
        const report = {
          accepted: [] as unknown[],
          rejected: [] as unknown[],
          authorOrigins: [] as unknown[],
          ready: 0,
          wires: [] as Record<string, unknown>[],
          credits: [] as number[],
          invalidPortPackets: [] as unknown[],
        };
        let peer: MessagePort | null = null;
        let received = 0;
        addEventListener("message", (event) => {
          if (event.data?.nativeAuthorOriginProbe) {
            const inner =
              carrier.contentWindow?.document.querySelector("iframe");
            report.authorOrigins.push({
              origin: event.origin,
              actualInnerSource: event.source === inner?.contentWindow,
            });
            return;
          }
          if (event.data?.protocol !== protocol) return;
          const packet = {
            origin: event.origin,
            actualCarrierSource: event.source === carrier.contentWindow,
            proof: event.data.proof,
            ports: event.ports.length,
          };
          if (
            event.origin !== "morphz://app" ||
            event.source !== carrier.contentWindow ||
            event.data.proof !== proof ||
            event.ports.length !== 1 ||
            peer
          ) {
            report.rejected.push(packet);
            for (const port of event.ports) port.close();
            return;
          }
          report.accepted.push(packet);
          peer = event.ports[0]!;
          peer.onmessage = (event) => {
            const packet = event.data;
            if (
              packet?.kind === "parser-ready" &&
              Object.keys(packet).length === 1
            ) {
              report.ready++;
              peer!.postMessage({
                kind: "wire",
                text: JSON.stringify({
                  kind: "init",
                  marker: "native-original-owner",
                }),
              });
            } else if (
              packet?.kind === "wire" &&
              Object.keys(packet).length === 2 &&
              typeof packet.text === "string"
            ) {
              report.wires.push(JSON.parse(packet.text));
              peer!.postMessage({ kind: "credit", sequence: ++received });
            } else if (
              packet?.kind === "credit" &&
              Object.keys(packet).length === 2
            )
              report.credits.push(packet.sequence);
            else report.invalidPortPackets.push(packet);
          };
          peer.start();
        });
        Object.assign(window, {
          nativeDocumentHost: {
            report() {
              return structuredClone(report);
            },
            retire() {
              peer?.close();
              carrier.remove();
            },
          },
        });
        carrier.src = path;
        document.body.append(carrier);
      },
      { path, proof, protocol: cognitiveDocumentBootstrapProtocol },
    );
    await owner.waitForFunction(
      () =>
        Reflect.get(window, "nativeDocumentHost")
          .report()
          .wires.some(
            (packet: { type?: string; kind?: string }) =>
              packet.type === "delivered" && packet.kind === "init",
          ),
      undefined,
      { timeout: 10000 },
    );
    const native = await owner.evaluate(() =>
      Reflect.get(window, "nativeDocumentHost").report(),
    );
    assert.deepEqual(native.accepted, [
      { origin: "morphz://app", actualCarrierSource: true, proof, ports: 1 },
    ]);
    assert.deepEqual(native.authorOrigins, [
      { origin: "null", actualInnerSource: true },
    ]);
    assert.equal(native.rejected.length, 1);
    assert.deepEqual(native.rejected[0], {
      origin: "null",
      actualCarrierSource: false,
      proof,
      ports: 1,
    });
    assert.equal(native.ready, 1);
    assert.deepEqual(native.invalidPortPackets, []);
    assert.deepEqual(
      native.wires.find(
        (value: { type?: string }) => value.type === "author-inspection",
      ),
      {
        type: "author-inspection",
        node: "undefined",
        bridge: "undefined",
        parentDOM: false,
        ownerDOM: false,
        secondClaimDenied: true,
        facadeKeys: ["check", "send", "subscribe", "dispose"],
        original: "原生作者原文 😀",
      },
    );
    assert.deepEqual(
      native.wires.find(
        (value: { type?: string }) => value.type === "delivered",
      ),
      { type: "delivered", kind: "init", marker: "native-original-owner" },
    );
    await owner.waitForFunction(
      () =>
        Reflect.get(window, "nativeDocumentHost").report().credits.length === 1,
    );
    assert.deepEqual(
      await owner.evaluate(
        () => Reflect.get(window, "nativeDocumentHost").report().credits,
      ),
      [1],
    );
    console.log(
      "Actual native frame URLs: " +
        JSON.stringify(owner.frames().map((frame) => frame.url())),
    );
    // Electron exposes this opaque OOPIF's URL as an empty string, not
    // about:srcdoc. Follow the real DOM frame hierarchy rather than assuming it.
    assert.equal(
      await owner
        .frameLocator("#native-document-carrier")
        .frameLocator("iframe")
        .locator("#native-original")
        .textContent(),
      "原生作者原文 😀",
    );
    const observed = await electron.evaluate(() =>
      Reflect.get(globalThis, "__cognitiveDocumentNativeFixture").report(),
    );
    assert.equal(observed.documentReads.length, 3);
    assert.ok(
      observed.documentReads.every(
        (value: { request: unknown; hasSignal: boolean }) =>
          JSON.stringify(value.request) === JSON.stringify(metadata.request) &&
          value.hasSignal,
      ),
    );
    assert.equal(observed.rawReads, 0);
    assert.equal(observed.legacyReads, 0);
    assert.equal(observed.tcpAttempts, 0);
    assert.deepEqual(errors, []);
    console.log(
      "Actual isolated Electron native origin witness: " +
        JSON.stringify({
          accepted: native.accepted,
          authorOrigins: native.authorOrigins,
          rejected: native.rejected,
          ready: native.ready,
          credits: (
            await owner.evaluate(() =>
              Reflect.get(window, "nativeDocumentHost").report(),
            )
          ).credits,
          tcpAttempts: observed.tcpAttempts,
        }),
    );
    await owner.evaluate(() =>
      Reflect.get(window, "nativeDocumentHost").retire(),
    );
  },
);
