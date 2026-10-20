import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { retainCognitiveNetworkResponses } from "./fixtures/cognitive-network-observer.js";

test(
  "actual Chromium response evidence survives cross-process navigation without another HTTP request",
  { timeout: 30_000 },
  async (context) => {
    const payload = JSON.stringify({
      grantRevision: 3,
      body: "test-only ".repeat(100_000),
    });
    let sourceRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.url === "/source") {
        sourceRequests++;
        response.setHeader("Content-Type", "application/json");
        response.end(payload);
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(
          "<!doctype html><title>TEST response lifetime</title>TEST",
        );
      }
    });
    context.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({
      executablePath:
        process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath(),
      headless: true,
    });
    context.after(() => browser.close());
    for (const retained of [false, true]) {
      const owner = await browser.newContext();
      try {
        const page = await owner.newPage();
        const network = await owner.newCDPSession(page);
        let requestId: string | undefined;
        network.on("Network.responseReceived", (event) => {
          if (new URL(event.response.url).pathname === "/source")
            requestId = event.requestId;
        });
        if (retained) await retainCognitiveNetworkResponses(network);
        else {
          await network.send("Network.enable");
          await network.send("Network.configureDurableMessages", {});
        }
        await page.goto(`http://127.0.0.1:${address.port}/`);
        assert.equal(
          await page.evaluate(
            async () => (await (await fetch("/source")).json()).grantRevision,
          ),
          3,
        );
        assert.ok(requestId);
        await page.goto(`http://localhost:${address.port}/replacement`);
        const read = network.send("Network.getResponseBody", { requestId });
        if (!retained) {
          await assert.rejects(read, /No (?:resource|data).*identifier/);
          continue;
        }
        const body = await read;
        const text = body.base64Encoded
          ? Buffer.from(body.body, "base64").toString("utf8")
          : body.body;
        assert.equal(
          text,
          payload,
          "the actual original response is retained byte-for-byte",
        );
      } finally {
        await owner.close();
      }
    }
    assert.equal(
      sourceRequests,
      2,
      "one physical request per lane; no repair fetch",
    );
  },
);
