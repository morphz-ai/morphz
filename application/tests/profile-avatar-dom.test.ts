import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import sharp from "sharp";

// This is an isolated component fixture, not acceptance of the user's Desktop.
const fixtureModule = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfileAvatar } from '/src/ProfileAvatar.tsx';
import '/src/styles.css';
import '/src/ui.css';
import '/src/visual-system.css';
import '/src/profile-avatar.css';
const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Cpath fill="%239eadbc" d="M0 0h48v48H0z"/%3E%3C/svg%3E';
const animatedImage = '__ANIMATED_IMAGE__';
function Fixture() {
  const [state, setState] = useState('idle');
  const [active, setActive] = useState(true);
  const [motion, setMotion] = useState(true);
  return <main className="app workspace-content" data-accent="cyan" style={{height:'auto',padding:32,display:'block',width:'100%',boxSizing:'border-box',color:'var(--ink)'}}>
    <div style={{display:'flex', gap:32,alignItems:'center',marginBottom:32}}>
      {['seed','fold','wing'].map(concept=><div key={concept} data-candidate={concept} style={{display:'flex',flexDirection:'column',gap:12,alignItems:'center'}}>
        <span style={{fontSize:12}}>{concept}</span>
        <div style={{display:'flex',gap:12,alignItems:'center'}}>
        <ProfileAvatar name="阿叶" concept={concept} state={state} active={active} allowMotion={motion}/>
        <ProfileAvatar name="阿叶" concept={concept} size={32} state={state} active={active} allowMotion={motion}/>
        </div>
      </div>)}
    </div>
    <div style={{display:'flex',gap:24}}>
    <section data-test="primary"><ProfileAvatar name="阿叶" label="阿叶：实际工作状态" state={state} active={active} allowMotion={motion}/></section>
    <section data-test="still"><ProfileAvatar name="小林" src={image} state={state} active={active} allowMotion={motion}/></section>
    <section data-test="dynamic"><ProfileAvatar name="小林" src={image} animated active={active} allowMotion={motion}/></section>
    <section data-test="poster"><ProfileAvatar name="小林" src={animatedImage} animated posterSrc={image} active={active} allowMotion={motion}/></section>
    <section data-test="broken"><ProfileAvatar name="小林" src="/missing.png" /></section>
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:24}}>
      {['idle','processing','working','approval','paused','waiting','offline','unavailable'].map(value=><button key={value} onClick={()=>setState(value)}>{value}</button>)}
      <button onClick={()=>setActive(value=>!value)}>toggle active</button>
      <button onClick={()=>setMotion(value=>!value)}>toggle motion</button>
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

const browserExecutable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
test(
  "实际 DOM 的独立眼睛眨眼／视线／折面动作，状态和无动态退化保持尺寸",
  {
    timeout: 45000,
    skip:
      !browserExecutable && !existsSync(chromium.executablePath())
        ? "No matching Playwright browser; set MORPHZ_TEST_BROWSER_EXECUTABLE for the DOM integration fixture"
        : false,
  },
  async (context) => {
    const frame = (background: string) =>
      sharp({ create: { width: 48, height: 48, channels: 4, background } })
        .png()
        .toBuffer();
    const animatedBytes = await sharp(
      await Promise.all([frame("#9eadbc"), frame("#b9cadf")]),
      { join: { animated: true } },
    )
      .gif({ delay: [200, 200], loop: 0 })
      .toBuffer();
    const animatedSource = `data:image/gif;base64,${animatedBytes.toString("base64")}`;
    const source = fixtureModule.replace("__ANIMATED_IMAGE__", animatedSource);
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      plugins: [
        react(),
        {
          name: "profile-avatar-isolated-fixture",
          resolveId(id) {
            if (id === "/__avatar-fixture.tsx") return "\0avatar-fixture.tsx";
          },
          async load(id) {
            if (id === "\0avatar-fixture.tsx")
              return transformWithOxc(source, "avatar-fixture.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__avatar-fixture") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<html><head></head><body style="margin:0"><div id="root"></div><script type="module" src="/__avatar-fixture.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    context.after(async () => {
      await server.close();
    });
    const browser = await chromium.launch({
      // The optional headed pass is the focus/blur evidence. Headless Chromium
      // deliberately reports background pages focused and cannot prove this.
      headless: process.env.MORPHZ_TEST_BROWSER_HEADED !== "1",
      executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || undefined,
    });
    context.after(async () => {
      await browser.close();
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const browserContext = await browser.newContext({
      viewport: { width: 800, height: 560 },
    });
    const page = await browserContext.newPage();
    if (process.env.MORPHZ_TEST_BROWSER_HEADED === "1") {
      const session = await browserContext.newCDPSession(page);
      // Playwright enables focus emulation by default on every Chromium page.
      // Restore real focus semantics rather than dispatching synthetic events.
      await session.send("Emulation.setFocusEmulationEnabled", {
        enabled: false,
      });
      await page.bringToFront();
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({
      reducedMotion: "no-preference",
      colorScheme: "light",
    });
    await page.goto(`http://127.0.0.1:${address.port}/__avatar-fixture`);
    const primary = page.locator('[data-test="primary"] .profile-avatar');
    await primary.waitFor();
    assert.equal(
      await primary.getAttribute("aria-label"),
      "阿叶：实际工作状态",
    );
    assert.equal(await primary.locator("ellipse").count(), 2);
    const originalBounds = await primary.boundingBox();
    assert.equal(originalBounds?.width, 96);
    assert.equal(originalBounds?.height, 96);
    assert.equal(
      await primary
        .locator("svg")
        .evaluate((node) => getComputedStyle(node).width),
      "96px",
    );
    assert.equal(
      await primary
        .locator("svg")
        .evaluate((node) => getComputedStyle(node).height),
      "96px",
    );

    async function sample(selector: string, name: string, time: number) {
      return primary.locator(selector).evaluate(
        (node, values) => {
          const animation = node
            .getAnimations()
            .find(
              (value) => (value as CSSAnimation).animationName === values.name,
            );
          if (!animation)
            throw new Error(`Missing live animation ${values.name}`);
          animation.pause();
          animation.currentTime = values.time;
          return getComputedStyle(node).transform;
        },
        { name, time },
      );
    }
    const open = await sample(
      ".profile-avatar-eyes",
      "profile-avatar-blink",
      0,
    );
    const blink = await sample(
      ".profile-avatar-eyes",
      "profile-avatar-blink",
      3306,
    );
    assert.notEqual(open, blink);
    await page.getByRole("button", { name: "working", exact: true }).click();
    const glanceStart = await sample(
      ".profile-avatar-look",
      "profile-avatar-thought",
      0,
    );
    const glance = await sample(
      ".profile-avatar-look",
      "profile-avatar-thought",
      1440,
    );
    assert.notEqual(glanceStart, glance);
    const foldStart = await sample(
      ".profile-avatar-fold-left",
      "profile-avatar-fold-left",
      0,
    );
    const fold = await sample(
      ".profile-avatar-fold-left",
      "profile-avatar-fold-left",
      1600,
    );
    assert.notEqual(foldStart, fold);
    assert.equal(
      await primary
        .locator(".profile-avatar-body")
        .evaluate((node) => node.getAnimations().length),
      0,
    );
    assert.deepEqual(await primary.boundingBox(), originalBounds);
    const small = page.locator('[data-candidate="seed"] [data-small="true"]');
    assert.equal(
      await small
        .locator(".profile-avatar-fold-left")
        .evaluate((node) => node.getAnimations().length),
      0,
    );
    assert.equal(
      await small
        .locator("svg")
        .evaluate((node) => getComputedStyle(node).width),
      "32px",
    );

    // A real second browser page changes the OS/browser focus state; no
    // synthetic focus dispatch or forced document.hasFocus override is used.
    // Headless-only runs keep the other DOM assertions but do not claim focus QA.
    if (process.env.MORPHZ_TEST_BROWSER_HEADED === "1") {
      const media = page.locator('[data-test="poster"] .profile-avatar');
      await page.bringToFront();
      await page.waitForFunction(() => document.hasFocus());
      assert.equal(await media.getAttribute("data-motion"), "on");
      assert.equal(
        await media.locator("img").getAttribute("src"),
        animatedSource,
      );
      const other = await browserContext.newPage();
      const session = await browserContext.newCDPSession(other);
      await session.send("Emulation.setFocusEmulationEnabled", {
        enabled: false,
      });
      await other.goto("about:blank");
      await other.bringToFront();
      await page.waitForFunction(() => !document.hasFocus());
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-test="primary"] .profile-avatar')
            ?.getAttribute("data-motion") === "off",
      );
      assert.equal(
        await primary.evaluate(
          (node) => node.getAnimations({ subtree: true }).length,
        ),
        0,
      );
      assert.equal(await media.getAttribute("data-motion"), "off");
      assert.equal(
        await media.locator("img").getAttribute("src"),
        await page.locator('[data-test="still"] img').getAttribute("src"),
      );
      assert.deepEqual(await primary.boundingBox(), originalBounds);
      await page.bringToFront();
      await page.waitForFunction(() => document.hasFocus());
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-test="primary"] .profile-avatar')
            ?.getAttribute("data-motion") === "on",
      );
      assert.equal(
        await media.locator("img").getAttribute("src"),
        animatedSource,
      );
      assert.deepEqual(await primary.boundingBox(), originalBounds);
      assert.ok(
        await primary.evaluate(
          (node) => node.getAnimations({ subtree: true }).length > 0,
        ),
      );
      await other.close();
    } else {
      context.diagnostic(
        "Window focus QA requires MORPHZ_TEST_BROWSER_HEADED=1; headless results do not prove blur/restore.",
      );
    }

    const screenshotDir = await mkdtemp(
      resolve(tmpdir(), "morphz-avatar-concepts-"),
    );
    await page.screenshot({
      path: resolve(screenshotDir, "concepts-light.png"),
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
      path: resolve(screenshotDir, "concepts-dark.png"),
    });
    context.diagnostic(`Concept and actual DOM screenshots: ${screenshotDir}`);

    await page.getByRole("button", { name: "approval", exact: true }).click();
    assert.equal(
      await primary
        .locator(".profile-avatar-mouth")
        .evaluate((node) => getComputedStyle(node).display),
      "none",
    );
    assert.equal(
      await primary
        .locator(".profile-avatar-attentive-mouth")
        .evaluate((node) => getComputedStyle(node).display),
      "block",
    );
    await page.getByRole("button", { name: "paused", exact: true }).click();
    assert.equal(
      await primary
        .locator(".profile-avatar-eyes")
        .evaluate((node) => getComputedStyle(node).display),
      "none",
    );
    assert.equal(
      await primary
        .locator(".profile-avatar-rest-eyes")
        .evaluate((node) => getComputedStyle(node).display),
      "block",
    );
    for (const state of ["offline", "unavailable"]) {
      await page.getByRole("button", { name: state, exact: true }).click();
      assert.equal(await primary.getAttribute("data-motion"), "off");
      assert.equal(
        await primary.evaluate(
          (node) => node.getAnimations({ subtree: true }).length,
        ),
        0,
      );
      assert.deepEqual(await primary.boundingBox(), originalBounds);
    }
    await page.getByRole("button", { name: "working", exact: true }).click();
    await page.getByRole("button", { name: "toggle active" }).click();
    assert.equal(await primary.getAttribute("data-motion"), "off");
    assert.equal(
      await primary.evaluate(
        (node) => node.getAnimations({ subtree: true }).length,
      ),
      0,
    );
    assert.equal(
      await page
        .locator('[data-test="dynamic"] .profile-avatar')
        .getAttribute("data-avatar-kind"),
      "initial",
    );
    await page.getByRole("button", { name: "toggle active" }).click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-test="primary"] .profile-avatar')
          ?.getAttribute("data-motion") === "off",
    );
    assert.equal(
      await primary.evaluate(
        (node) => node.getAnimations({ subtree: true }).length,
      ),
      0,
    );
    assert.equal(
      await page
        .locator('[data-test="dynamic"] .profile-avatar')
        .getAttribute("data-avatar-kind"),
      "initial",
    );
    assert.equal(
      await page.locator('[data-test="poster"] img').getAttribute("src"),
      await page.locator('[data-test="still"] img').getAttribute("src"),
    );
    assert.equal(await page.locator('[data-test="still"] img').count(), 1);
    assert.equal(await page.locator('[data-test="still"] svg').count(), 0);
    assert.equal(
      await page
        .locator('[data-test="broken"] .profile-avatar')
        .getAttribute("data-avatar-kind"),
      "initial",
    );
    assert.deepEqual(errors, []);
  },
);
