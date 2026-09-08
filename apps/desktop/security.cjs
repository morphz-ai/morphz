const APP_ORIGINS = new Set([
  "http://127.0.0.1:65420",
  "http://127.0.0.1:65419",
]);
function trustedAppURL(value, center) {
  try {
    const url = new URL(value);
    return (
      (center ? url.origin === center : APP_ORIGINS.has(url.origin)) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function centerFromArgs(args) {
  const values = args.filter((a) => a.startsWith("--center="));
  if (values.length > 1) throw new Error("只能指定一个中心。");
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
    throw new Error("本轮桌面只连接明确指定的本地中心 HTTP 地址。");
  return u.origin;
}
module.exports = {
  centerFromArgs,
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
