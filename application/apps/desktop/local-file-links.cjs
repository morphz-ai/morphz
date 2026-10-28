const { realpath, stat } = require("node:fs/promises");
const { isAbsolute, extname } = require("node:path");

const launchable = new Set([
  ".app",
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".command",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".vbs",
  ".js",
  ".jse",
  ".py",
  ".pyw",
  ".rb",
  ".pl",
  ".php",
  ".vbe",
  ".wsf",
  ".wsh",
  ".msi",
  ".msp",
  ".pkg",
  ".dmg",
  ".deb",
  ".rpm",
  ".desktop",
  ".jar",
  ".scpt",
  ".applescript",
  ".workflow",
  ".action",
  ".lnk",
  ".url",
  ".webloc",
  ".hta",
  ".scr",
  ".cpl",
]);

/** Only an explicit trusted-main-frame Human click may call this. Never a
 * generic shell/protocol opener, import, filesystem grant or Agent operation. */
function createLocalFileOpener({ requireMain, shell, isLocal }) {
  return async (event, value) => {
    requireMain(event);
    if (!isLocal()) throw new Error("远端工作空间的路径不能作为本机文件打开。");
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      !isAbsolute(value) ||
      /^[\\/]{2}/.test(value)
    )
      throw new Error("本地文件地址无效，请使用本机绝对路径。");
    let path, info;
    try {
      path = await realpath(value);
      info = await stat(path);
    } catch (cause) {
      if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR")
        throw new Error("文件不存在或已移动，请核对路径后重试。");
      if (cause?.code === "EACCES" || cause?.code === "EPERM")
        throw new Error("没有权限打开此文件，请检查系统访问权限。");
      throw new Error("本地文件暂时无法读取，请检查路径和磁盘连接。");
    }
    requireMain(event);
    if (!isLocal()) throw new Error("工作空间连接已变化，文件未打开。");
    if (!info.isFile() && !info.isDirectory())
      throw new Error("此路径不是普通文件或文件夹，不能打开。");
    if (/^[\\/]{2}/.test(path)) throw new Error("不支持远程共享文件地址。");
    if (
      launchable.has(extname(path).toLowerCase()) ||
      launchable.has(extname(value).toLowerCase()) ||
      (info.isFile() && process.platform !== "win32" && info.mode & 0o111)
    ) {
      shell.showItemInFolder(path);
      return { action: "revealed" };
    }
    const failure = await shell.openPath(path);
    if (failure)
      throw new Error(
        "系统未能打开此文件，请检查默认应用或在文件管理器中打开。",
      );
    return { action: "opened" };
  };
}
module.exports = { createLocalFileOpener };
