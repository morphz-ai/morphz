const APP_ORIGINS = new Set([
  "morphz://app",
  "http://127.0.0.1:65420",
  "http://127.0.0.1:65419",
]);
function applicationOrigin(url) {
  if (url.protocol === "morphz:" && url.host === "app") return "morphz://app";
  return url.origin === "null" ? "" : url.origin;
}
function trustedAppURL(value, center) {
  try {
    const url = new URL(value);
    return (
      (center
        ? applicationOrigin(url) === center
        : APP_ORIGINS.has(applicationOrigin(url))) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function trustedMainURL(value, origin) {
  if (!trustedAppURL(value, origin)) return false;
  const url = new URL(value);
  return ["/", "/index.html"].includes(url.pathname) && !url.search;
}
function connectionFromArgs(args, defaultDirectory) {
  const centers = args.filter((arg) => arg.startsWith("--center="));
  const directories = args.filter((arg) => arg.startsWith("--data-dir="));
  if (
    centers.length > 1 ||
    directories.length > 1 ||
    (centers.length && directories.length)
  )
    throw new Error("请选择一个本机数据目录或一个远端工作空间，不能混用。");
  if (centers.length) {
    const url = new URL(centers[0].slice(9));
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1" &&
          Number(url.port) >= 1024
        )) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "远端连接需要明确的 HTTPS 地址；HTTP 仅接受数字本机回环地址。",
      );
    return { mode: "remote", url: url.origin };
  }
  const directory =
    directories[0]?.slice(11) ??
    (typeof defaultDirectory === "function"
      ? defaultDirectory()
      : defaultDirectory);
  if (!require("node:path").isAbsolute(directory))
    throw new Error("本机数据目录必须是绝对路径。");
  return { mode: "local", directory };
}
function centerFromArgs(args) {
  const values = args.filter((a) => a.startsWith("--center="));
  if (values.length > 1) throw new Error("只能指定一个应用服务地址。");
  const value =
    values[0]?.slice(9) ??
    (args.includes("--development")
      ? "http://127.0.0.1:65419"
      : "http://127.0.0.1:65420");
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    Number(u.port) < 1024 ||
    Number(u.port) > 65535
  )
    throw new Error("兼容模式仅接受明确指定的本机 HTTP 服务地址。");
  return u.origin;
}
module.exports = {
  centerFromArgs,
  connectionFromArgs,
  trustedMainURL,
  applicationOrigin,
  trustedAppURL,
  webPreferences: Object.freeze({
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  }),
};
