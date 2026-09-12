const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdtemp, open, rm } = require("node:fs/promises");
const { constants } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
class DesktopCapture {
  constructor({
    platform = process.platform,
    runner = promisify(execFile),
    temporary = tmpdir(),
    chooseRegion,
    getWindow = () => null,
    settleWindow = () => new Promise((resolve) => setTimeout(resolve, 100)),
  } = {}) {
    this.platform = platform;
    this.runner = runner;
    this.temporary = temporary;
    this.chooseRegion = chooseRegion;
    this.getWindow = getWindow;
    this.settleWindow = settleWindow;
    this.active = null;
    this.hiddenWindow = null;
  }
  cancel() {
    this.active?.abort();
  }
  async select(options = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== "hideWindow") ||
      (options.hideWindow !== undefined &&
        typeof options.hideWindow !== "boolean")
    )
      throw new Error("截图选项无效。");
    if (this.platform !== "darwin")
      throw new Error("当前仅接入 macOS 系统截图，请先导入图片文件。");
    if (this.active) throw new Error("已有截图选择正在进行。");
    const controller = new AbortController();
    this.active = controller;
    let directory;
    let hiddenWindow;
    let closingWindow = false;
    const onClose = () => {
      closingWindow = true;
      controller.abort();
    };
    try {
      const window = options.hideWindow ? this.getWindow() : null;
      if (window && !window.isDestroyed() && window.isVisible()) {
        hiddenWindow = this.hiddenWindow = window;
        window.once("close", onClose);
        // Hide only our main window, not the app (which also owns the picker).
        // Keep it hidden until pixel capture and cleanup have both finished.
        window.hide();
        await this.settleWindow();
      }
      if (controller.signal.aborted) return null;
      const region = this.chooseRegion
        ? await this.chooseRegion(controller.signal)
        : undefined;
      if (controller.signal.aborted || (this.chooseRegion && !region))
        return null;
      if (
        region &&
        (![region.x, region.y, region.width, region.height].every(
          Number.isInteger,
        ) ||
          region.width < 8 ||
          region.height < 8)
      )
        throw new Error("截图选区无效。");
      directory = await mkdtemp(join(this.temporary, "morphz-capture-"));
      const path = join(directory, "selection.png");
      // Coordinates come only from the trusted picker after a human drag.
      // Never read the full screen first or accept renderer-supplied capture args.
      await this.runner(
        "/usr/sbin/screencapture",
        region
          ? [
              "-R",
              `${region.x},${region.y},${region.width},${region.height}`,
              "-x",
              "-t",
              "png",
              path,
            ]
          : ["-i", "-x", "-t", "png", path],
        { signal: controller.signal, timeout: 120000, maxBuffer: 4096 },
      );
      if (controller.signal.aborted) return null;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 6 * 1024 * 1024)
          throw new Error("截图超过 6 MB，请选取更小的范围。");
        const bytes = await file.readFile();
        if (
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("未获得有效的 PNG 截图。");
        return { mime: "image/png", data: bytes.toString("base64") };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        error?.code === 1 ||
        error?.code === "ENOENT"
      )
        return null;
      if (error?.killed) throw new Error("截图选择已超时，请重试。");
      throw new Error(
        error?.message?.startsWith("截图超过")
          ? error.message
          : "截图未成功，请检查系统屏幕录制权限后再试。",
      );
    } finally {
      try {
        // This directory contains only this operation's generated temporary screenshot.
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        if (this.active === controller) this.active = null;
        if (this.hiddenWindow === hiddenWindow) this.hiddenWindow = null;
        if (hiddenWindow) {
          hiddenWindow.removeListener("close", onClose);
          if (!closingWindow && !hiddenWindow.isDestroyed())
            hiddenWindow.show();
        }
      }
    }
  }
}
module.exports = { DesktopCapture };
