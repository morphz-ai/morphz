import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";

test(
  "a fresh paused browser clock preserves exact time without a running-install race",
  { timeout: 30_000 },
  async (context) => {
    const browser = await chromium.launch({
      executablePath:
        process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath(),
    });
    context.after(() => browser.close());
    const at = new Date("2026-10-04T00:00:00Z");
    const old = await browser.newPage();
    await old.clock.install({ time: at });
    await old.waitForFunction((start) => Date.now() > start, at.getTime());
    await assert.rejects(
      old.clock.pauseAt(at),
      /Cannot fast-forward to the past/,
    );
    await old.close();

    const page = await browser.newPage();
    await page.clock.pauseAt(at);
    await page.goto(
      "data:text/html,<script>window.fired=0;setTimeout(()=>window.fired++,300)</script>",
    );
    assert.equal(await page.evaluate(() => Date.now()), at.getTime());
    assert.equal(await page.evaluate(() => Reflect.get(window, "fired")), 0);
    await page.clock.runFor(299);
    assert.equal(await page.evaluate(() => Reflect.get(window, "fired")), 0);
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(() => Reflect.get(window, "fired")), 1);
    assert.equal(await page.evaluate(() => Date.now()), at.getTime() + 300);
  },
);
