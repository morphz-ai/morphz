import { test, expect, type Page } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

async function syntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, "micCalls", 0);
    navigator.mediaDevices.getUserMedia = async () => {
      Reflect.set(window, "micCalls", Reflect.get(window, "micCalls") + 1);
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      await context.resume();
      oscillator.start();
      const stream = destination.stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          void context.close();
        };
      }
      Reflect.set(window, "micStream", stream);
      return stream;
    };
  });
  await page.route("**/api/speech/transcribe", (route) =>
    route.fulfill({ json: { text: "合成听写" } }),
  );
  const streams = new Map<
    string,
    { id: string; text: string; revision: number; status: string }
  >();
  await page.route("**/api/speech/stream", async (route) => {
    const command = route.request().postDataJSON();
    let state = streams.get(command.id);
    if (!state) {
      state = { id: command.id, text: "", revision: 0, status: "listening" };
      streams.set(command.id, state);
    }
    if (command.action === "push" && !state.text) {
      expect(command.data.length).toBeLessThanOrEqual(6400);
      state.text = "合成听";
      state.revision++;
    }
    if (command.action === "finish") {
      state.text = "合成听写";
      state.status = "complete";
      state.revision++;
    }
    if (command.action === "cancel") {
      state.status = "cancelled";
      state.revision++;
    }
    if (command.action === "read")
      await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ json: state });
  });
}

async function stopped(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Reflect.get(window, "micStream")
          ?.getTracks()
          .every((track: MediaStreamTrack) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
}

test("首次许可明确服务，之后单击即听写；同一按钮停止、重新打开和刷新保留许可", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: "doubao",
        providerLabel: "豆包",
        streaming: true,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("保留草稿");
  const mic = page.getByRole("button", { name: "语音输入", exact: true });
  const consent = page.getByRole("dialog", { name: "语音输入授权" });
  const voice = page.getByRole("region", { name: "听写", exact: true });
  await mic.click();
  await expect(consent).toContainText("持续分段发送至豆包");
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(0);
  await page.keyboard.press("Escape");
  await expect(consent).toHaveCount(0);
  await expect(input).toHaveValue("保留草稿");
  await mic.click();
  await consent.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(voice).toHaveAttribute("data-recording", "true");
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue("保留草稿\n合成听", { timeout: 3000 });
  await expect(voice).toHaveAttribute("data-recording", "true");
  await expect
    .poll(() =>
      voice
        .getByLabel("麦克风音量")
        .evaluate((meter: HTMLMeterElement) => meter.value),
    )
    .toBeGreaterThan(0);
  await expect(voice).not.toContainText("开始后录音将发送");
  await page.setViewportSize({ width: 320, height: 600 });
  await expect(voice).toBeInViewport();
  expect(
    await voice.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await voice.screenshot({
    path: "test-results/one-click-dictation-compact.png",
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByLabel("长录音转写", { exact: true })).toHaveCount(0);
  await mic.click();
  await stopped(page);
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(input).toHaveValue("保留草稿\n合成听写");
  await voice.getByRole("button", { name: "关闭听写" }).click();
  await mic.click();
  await expect(voice).toHaveAttribute("data-recording", "true");
  await expect(consent).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(2);
  await page.keyboard.press("Escape");
  await stopped(page);
  await page.reload();
  await openInput(page);
  await mic.click();
  await expect(voice).toHaveAttribute("data-recording", "true");
  await expect(consent).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await stopped(page);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(voice).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(1);
  await expect(input).toHaveValue("保留草稿\n合成听写");
});

test("从听写切换独立转写会停采，不让旧识别队列串入另一种界面", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", streaming: true },
    }),
  );
  await page.goto("/");
  await openInput(page);
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await page.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(
    page.getByRole("region", { name: "听写", exact: true }),
  ).toHaveAttribute("data-recording", "true");
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  await page
    .getByRole("group", { name: "工作空间操作", exact: true })
    .screenshot();
  await page.getByRole("button", { name: "录音转文字", exact: true }).click();
  await stopped(page);
  const dialog = page.getByRole("dialog", { name: "录音转文字", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "开始录音", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
});

test("可撤销授权，服务变更重新确认；拒绝或读取配置时关闭不会采集", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  let provider = "doubao";
  let release: (() => void) | undefined;
  let hold = false;
  await page.route("**/api/speech/status", async (route) => {
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      json: {
        configured: true,
        streaming: true,
        provider,
        providerLabel: provider === "doubao" ? "豆包" : "测试识别服务",
      },
    });
  });
  await page.goto("/");
  await openInput(page);
  const mic = page.getByRole("button", { name: "语音输入", exact: true });
  const voice = page.getByRole("region", { name: "听写", exact: true });
  const consent = page.getByRole("dialog", { name: "语音输入授权" });
  await mic.click();
  await consent.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(voice).toHaveAttribute("data-recording", "true");
  await mic.click();
  await stopped(page);
  await voice.getByRole("button", { name: "语音服务与授权" }).click();
  await consent.getByRole("button", { name: "撤销一键听写授权" }).click();
  await mic.click();
  await expect(consent).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(1);
  await consent.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(voice).toHaveAttribute("data-recording", "true");
  await page.keyboard.press("Escape");
  await stopped(page);
  provider = "different-service";
  await mic.click();
  await expect(consent).toContainText("测试识别服务");
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(2);
  await consent.getByRole("button", { name: "暂不启用" }).click();
  provider = "doubao";
  hold = true;
  await mic.click();
  await expect.poll(() => !!release).toBe(true);
  await voice.getByRole("button", { name: "关闭听写" }).click();
  release!();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(voice).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(2);
});

test("等待系统麦克风授权时关闭，不因迟到的允许结果开始录音", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  await page.addInitScript(() =>
    Reflect.set(window, "morphzDesktop", {
      voice: {
        requestMicrophone: () =>
          new Promise<boolean>((resolve) =>
            Reflect.set(window, "releasePermission", resolve),
          ),
        cancelMicrophone: async () => {},
      },
    }),
  );
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", streaming: true },
    }),
  );
  await page.goto("/");
  await openInput(page);
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await page.getByRole("button", { name: "允许并开始听写" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof Reflect.get(window, "releasePermission")),
    )
    .toBe("function");
  await page.getByRole("button", { name: "关闭听写" }).click();
  await page.evaluate(() => Reflect.get(window, "releasePermission")(true));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => Reflect.get(window, "micCalls"))).toBe(0);
  await expect(
    page.getByRole("region", { name: "听写", exact: true }),
  ).toHaveCount(0);
});

test("实时听写中手工编辑立即停采，迟到结果不能覆盖草稿；重新开始不覆盖上一段", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", streaming: true },
    }),
  );
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("原稿");
  const mic = page.getByRole("button", { name: "语音输入", exact: true });
  const voice = page.getByRole("region", { name: "听写", exact: true });
  await mic.click();
  await page.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(input).toHaveValue("原稿\n合成听", { timeout: 3000 });
  await input.fill("这是我的手工修正");
  await stopped(page);
  await expect(voice).toContainText("已停止听写，继续编辑即可");
  await expect(input).toHaveValue("这是我的手工修正");
  await mic.click();
  await expect(input).toHaveValue("这是我的手工修正\n合成听", {
    timeout: 3000,
  });
  await mic.click();
  await expect(input).toHaveValue("这是我的手工修正\n合成听写");
  await expect(page.getByLabel("取消发送")).toHaveCount(0);
});

test("流式服务中断会关麦克风并保留已有文字，不能悄悄退回分段转写", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  let fail = false;
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", streaming: true },
    }),
  );
  await page.route("**/api/speech/stream", async (route) => {
    const { id, action } = route.request().postDataJSON();
    if (action === "read")
      await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      json: {
        id,
        revision: fail ? 2 : action === "open" ? 0 : 1,
        text: action === "open" ? "" : "已经识别的文字",
        status: fail ? "error" : "listening",
        ...(fail ? { error: "测试网络中断" } : {}),
      },
    });
  });
  await page.goto("/");
  const input = await openInput(page);
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await page.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(input).toHaveValue("已经识别的文字");
  fail = true;
  await expect(
    page.getByRole("region", { name: "听写", exact: true }),
  ).toContainText("测试网络中断");
  await stopped(page);
  await expect(input).toHaveValue("已经识别的文字");
});

test("停止后等待尾句时隐藏窗口，也取消旧流并忽略迟到最终结果", async ({
  page,
}) => {
  await syntheticMicrophone(page);
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({
      json: { configured: true, provider: "doubao", streaming: true },
    }),
  );
  let release: (() => void) | undefined;
  await page.route("**/api/speech/stream", async (route) => {
    const command = route.request().postDataJSON();
    if (command.action !== "finish") return route.fallback();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        id: command.id,
        revision: 99,
        text: "不能覆盖草稿的迟到结果",
        status: "complete",
      },
    });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("保留草稿");
  const mic = page.getByRole("button", { name: "语音输入", exact: true });
  const voice = page.getByRole("region", { name: "听写", exact: true });
  await mic.click();
  await page.getByRole("button", { name: "允许并开始听写" }).click();
  await expect(input).toHaveValue("保留草稿\n合成听");
  await mic.click();
  await expect(voice).toContainText("正在结束听写");
  await expect.poll(() => !!release).toBe(true);
  await stopped(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(voice).toContainText("窗口已隐藏，听写已停止");
  release!();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await voice.getByRole("button", { name: "关闭听写" }).click();
  await expect(input).toHaveValue("保留草稿\n合成听");
});
