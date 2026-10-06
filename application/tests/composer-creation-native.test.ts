import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { _electron, expect } from "@playwright/test";
import { createServer } from "vite";

test(
  "actual Electron page zoom 1/2 at 760px keeps + mouse-hit and popover reachable; controlled transport only",
  { timeout: 60_000 },
  async (t) => {
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-creation-native-vite-"),
    );
    const profile = await mkdtemp(
      resolve(tmpdir(), "morphz-creation-native-profile-"),
    );
    const evidenceDir = await mkdtemp(
      resolve(tmpdir(), "morphz-creation-native-evidence-"),
    );
    let closeDesktop = async () => {};
    let closeServer = async () => {};
    t.after(async () => {
      try {
        await closeDesktop();
      } finally {
        try {
          await closeServer();
        } finally {
          await Promise.all([
            rm(cacheDir, { recursive: true, force: true }),
            rm(profile, { recursive: true, force: true }),
          ]);
        }
      }
    });
    const fixture = resolve(
      "tests/fixtures/cognitive-application-choice-app-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "native-creation-menu-controlled-app",
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/__new-menu-native")
                return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url!,
                  `<!doctype html><html><head><link rel="icon" href="data:,"/></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    closeServer = () => server.close();
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__new-menu-native?mode=fresh`;
    const allowedEnvironment = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    const env = Object.fromEntries(
      allowedEnvironment.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    );
    const desktop = await _electron.launch({
      args: [resolve("tests/fixtures/composer-creation-native-entry.cjs")],
      env: {
        ...env,
        MORPHZ_CREATION_NATIVE_PROFILE: profile,
        MORPHZ_CREATION_NATIVE_URL: url,
      },
    });
    // Close owned Electron before removing its private profile and Vite cache.
    closeDesktop = () => desktop.close();
    const ownedElectronPid = await desktop.evaluate(() => process.pid);
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("textbox", { name: "AI 输入内容", exact: true })
      .waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      () =>
        Reflect.get(window, "cognitiveChoiceAppFixture")
          .report()
          .requests.filter(
            (r: { method: string }) => r.method === "cognitive-apps.list",
          ).length >= 2,
    );
    const report = () =>
      page.evaluate(() =>
        Reflect.get(window, "cognitiveChoiceAppFixture").report(),
      );
    const baseline = await report();
    const capture = async (name: string) => {
      // Electron's own compositor capture avoids Playwright's page-zoom/DPR
      // screenshot crop mismatch and never makes this automatic window visible.
      await page.evaluate(async () => {
        const menu = document.querySelector(".composer-options:popover-open");
        await Promise.all(
          (menu?.getAnimations({ subtree: true }) ?? [])
            .filter((animation) =>
              Number.isFinite(animation.effect?.getComputedTiming().iterations),
            )
            .map((animation) => animation.finished.catch(() => {})),
        );
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
      });
      const png = await desktop.evaluate(async ({ BrowserWindow }) => {
        const image =
          await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          );
        return image.toPNG().toString("base64");
      });
      await writeFile(resolve(evidenceDir, name), Buffer.from(png, "base64"), {
        mode: 0o600,
      });
    };
    const observations: unknown[] = [];
    t.after(async () => {
      await writeFile(
        resolve(evidenceDir, "observations.json"),
        JSON.stringify(
          {
            scope:
              "hidden automatic Electron window, controlled transport; not original App/manual/native-OS mouse acceptance",
            ownedElectronPid,
            errors,
            observations,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(`[native creation-menu evidence] ${evidenceDir}`);
    });
    for (const zoom of [1, 2]) {
      await desktop.evaluate(({ BrowserWindow }, factor) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setContentSize(760, 850);
        window.webContents.setZoomFactor(factor);
      }, zoom);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(760 / zoom);
      await page.evaluate(() =>
        Reflect.get(window, "cognitiveChoiceAppFixture").clearRequests(),
      );
      const plus = page.getByRole("button", {
        name: "新建或添加",
        exact: true,
      });
      await plus.scrollIntoViewIfNeeded();
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const geometry = await plus.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        const boxes = Object.fromEntries(
          [
            ".app",
            ".sidebar",
            ".primary-panel",
            ".exchange-panel",
            ".composer",
            ".composer-action-bar",
            ".composer-action-leading",
            ".composer-action-trailing",
            ".composer-settings-trigger",
            '[aria-label="语音输入"]',
            ".send",
          ].map((selector) => {
            const element = document.querySelector<HTMLElement>(selector);
            return [
              selector,
              element
                ? {
                    rect: element.getBoundingClientRect().toJSON(),
                    clientWidth: element.clientWidth,
                    cssWidth: getComputedStyle(element).width,
                  }
                : null,
            ];
          }),
        );
        return {
          innerWidth,
          innerHeight,
          htmlZoom: getComputedStyle(document.documentElement).zoom,
          mobileMedia: matchMedia("(max-width: 560px)").matches,
          scrollY,
          plus: rect.toJSON(),
          centerHitsPlus: hit === node || node.contains(hit),
          centerHitLabel: hit?.closest("button")?.getAttribute("aria-label"),
          boxes,
        };
      });
      const observation: {
        zoom: number;
        geometry: typeof geometry;
        popoverOpen?: boolean;
        mutationCallCount?: number;
        draftsUnchanged?: boolean;
      } = { zoom, geometry };
      observations.push(observation);
      await capture(`zoom-${zoom}-before.png`);
      assert.equal(
        geometry.htmlZoom,
        "1",
        "native page zoom must not inject CSS zoom",
      );
      assert.equal(
        geometry.mobileMedia,
        zoom === 2,
        "media queries follow actual page-zoom viewport",
      );
      assert(
        geometry.centerHitsPlus,
        `+ actual hit at page zoom ${zoom}: ${JSON.stringify(geometry)}`,
      );
      assert(
        geometry.plus.x >= 0 &&
          geometry.plus.y >= 0 &&
          geometry.plus.right <= geometry.innerWidth + 1 &&
          geometry.plus.bottom <= geometry.innerHeight + 1,
        "+ fully fits current layout viewport",
      );
      // Real pointer coordinates, not force or HTMLElement.click/keyboard activation.
      await page.mouse.click(
        geometry.plus.x + geometry.plus.width / 2,
        geometry.plus.y + geometry.plus.height / 2,
      );
      const menu = page.getByRole("group", { name: "新建与添加", exact: true });
      await expect(menu).toBeVisible();
      observation.popoverOpen = await menu.evaluate((node) =>
        node.matches(":popover-open"),
      );
      assert(observation.popoverOpen, "actual top-layer popover is open");
      await expect(
        menu.getByRole("button", { name: "新建事项，事项", exact: true }),
      ).toBeVisible();
      await capture(`zoom-${zoom}-menu.png`);
      const after = await report();
      observation.mutationCallCount = after.requests.filter(
        (r: { method: string }) =>
          /^(?:platform\.message|conversations\.create|app-views\.(?:launch|save|close)|cognitive-apps\.(?:install|grant|connect|connection-state|describe|read-object|invoke)|cognitive-app-views\.|objects\.|reading\.|script-studio\.)/.test(
            r.method,
          ),
      ).length;
      assert.equal(observation.mutationCallCount, 0);
      assert.deepEqual(after.unknown, []);
      assert.deepEqual(after.pending, baseline.pending);
      assert.deepEqual(after.drafts, baseline.drafts);
      observation.draftsUnchanged = true;
      await page.keyboard.press("Escape");
      await expect(menu).not.toBeVisible();
    }
    assert.deepEqual(errors, []);
  },
);
