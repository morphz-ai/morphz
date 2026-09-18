const fs = require("node:fs");
const { basename, dirname, extname, isAbsolute, join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

// A Human-confirmed save of one persisted domain export, NOT a renderer file API.
// Neither bytes nor destination paths can cross this IPC boundary from a caller.
function createScriptExportSaver({
  connection,
  requireMain,
  getWindow,
  dialog,
  buildDocx,
}) {
  let generation = 0;
  let pending = false;
  function validateRequest(value) {
    const keys = ["centerId", "principalId", "productionId", "exportId"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every(
        (key) =>
          typeof value[key] === "string" &&
          /^[a-zA-Z0-9_-]{1,200}$/.test(value[key]),
      )
    )
      throw new Error("导出请求无效：仅接受中心、身份、剧本与导出记录标识。");
    return Object.freeze(
      Object.fromEntries(keys.map((key) => [key, value[key]])),
    );
  }
  function authorized(boot, request) {
    if (
      boot?.centerId !== request.centerId ||
      boot?.principalId !== request.principalId
    )
      throw new Error("身份或工作空间已变化，未保存文件。");
    const production = boot.workspace?.scriptProductions?.find(
      (p) => p.id === request.productionId,
    );
    if (
      !production ||
      !boot.workspace.projects.some((p) => p.id === production.projectId) ||
      !production.exports.some((record) => record.id === request.exportId)
    )
      throw new Error("无权读取此剧本的导出记录。");
    return production;
  }
  function destinationState(path) {
    try {
      const stat = fs.lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("请选择普通的 .docx 文件，不能覆盖链接或目录。");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(
        ":",
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  return {
    invalidate() {
      generation++;
    },
    async save(event, raw) {
      requireMain(event);
      const request = validateRequest(raw);
      const window = getWindow();
      if (!window || window.isDestroyed() || !window.isFocused())
        throw new Error("请先回到 Morphz 窗口。");
      if (pending)
        throw new Error("已有 Word 保存正在进行，请完成或取消后重试。");
      pending = true;
      const started = generation;
      let temporary;
      const checkOrigin = () => {
        requireMain(event);
        if (
          started !== generation ||
          getWindow() !== window ||
          window.isDestroyed()
        )
          throw new Error("原工作窗口已变化，未保存文件。");
      };
      try {
        const before = await connection.call("workspace");
        checkOrigin();
        const production = authorized(before, request);
        const bytes = buildDocx(production, request.exportId);
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length > 32 * 1024 * 1024 ||
          bytes.length < 4 ||
          bytes[0] !== 0x50 ||
          bytes[1] !== 0x4b ||
          bytes[2] !== 3 ||
          bytes[3] !== 4
        )
          throw new Error("Word 导出内容无效或超出大小限制。");
        const digest = createHash("sha256").update(bytes).digest("hex");
        const name =
          production.title
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
            .slice(0, 80) || "剧本";
        const selected = await dialog.showSaveDialog(window, {
          title: "保存剧本 Word",
          buttonLabel: "保存 Word",
          defaultPath: `${name}-${request.exportId.slice(0, 8)}.docx`,
          filters: [{ name: "Word 文档", extensions: ["docx"] }],
          properties: ["showOverwriteConfirmation"],
        });
        checkOrigin();
        if (selected.canceled || !selected.filePath)
          return { status: "cancelled", exportId: request.exportId };
        const path = selected.filePath;
        if (!isAbsolute(path) || extname(path).toLowerCase() !== ".docx")
          throw new Error("请选择绝对路径的 .docx 文件。");
        const parent = fs.realpathSync(dirname(path));
        const original = destinationState(path);
        const recheck = async () => {
          const current = await connection.call("workspace");
          checkOrigin();
          const permitted = authorized(current, request);
          if (current.csrfToken !== before.csrfToken)
            throw new Error("登录身份已变化，请重新发起保存。");
          // A corrupt or replaced export receipt must not silently change the file.
          if (
            createHash("sha256")
              .update(buildDocx(permitted, request.exportId))
              .digest("hex") !== digest
          )
            throw new Error("导出记录已变化，请重新核对。");
        };
        await recheck();
        temporary = join(parent, `.morphz-script-${randomUUID()}.tmp`);
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        await recheck();
        if (
          fs.realpathSync(dirname(path)) !== parent ||
          destinationState(path) !== original
        )
          throw new Error("保存位置已变化，未覆盖目标文件，请重试。");
        // Publish only a complete file. New destinations use link so a concurrent
        // creator is not overwritten; existing destinations were confirmed by OS UI.
        let warning;
        if (original === null) {
          fs.linkSync(temporary, path);
          // Publication succeeded. A cleanup error must not turn an existing,
          // complete destination into a misleading failed-save response.
          const publishedTemporary = temporary;
          temporary = undefined;
          try {
            fs.unlinkSync(publishedTemporary);
          } catch {
            warning = "temporary-file-cleanup-failed";
          }
        } else {
          fs.renameSync(temporary, path);
          temporary = undefined;
        }
        return {
          status: "saved",
          exportId: request.exportId,
          filename: basename(path),
          bytes: bytes.length,
          sha256: digest,
          ...(warning ? { warning } : {}),
        };
      } finally {
        try {
          if (temporary) fs.rmSync(temporary, { force: true });
        } catch (error) {
          throw new Error(
            "本次未发布文件，且临时文件清理失败；请检查保存目录后再重试。",
            { cause: error },
          );
        } finally {
          pending = false;
        }
      }
    },
  };
}
module.exports = { createScriptExportSaver };
