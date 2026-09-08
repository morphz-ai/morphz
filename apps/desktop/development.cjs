const developmentOrigin = "http://127.0.0.1:65419";

function rendererURL(center, hot, packaged) {
  if (!hot) return center;
  if (packaged || center === developmentOrigin)
    throw new Error("热更新仅用于开发壳，且必须指定独立的中心地址。");
  return developmentOrigin;
}

// Developer-only transition to Vite. Never copy credentials or another identity.
const readPreferences = `(async () => {
  const response = await fetch('/api/workspace');
  if (!response.ok) return null;
  const boot = await response.json();
  if (typeof boot.centerId !== 'string' || typeof boot.principalId !== 'string') return null;
  const prefix = 'morphzwork:' + boot.centerId + ':' + boot.principalId + ':';
  return { centerId: boot.centerId, principalId: boot.principalId,
    entries: Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)) };
})()`;

function preferenceSeed(previous, current) {
  if (
    !previous ||
    !current ||
    previous.centerId !== current.centerId ||
    previous.principalId !== current.principalId
  )
    return [];
  const prefix = `morphzwork:${current.centerId}:${current.principalId}:`;
  const existing = new Set(current.entries.map(([key]) => key));
  return previous.entries.filter(
    ([key, value]) =>
      typeof key === "string" &&
      typeof value === "string" &&
      key.startsWith(prefix) &&
      !/:(pending|pdf):/.test(key.slice(prefix.length)) &&
      !existing.has(key),
  );
}

async function loadDevelopmentWindow(window, center, uiURL) {
  await window.loadURL(center);
  const previous = await window.webContents.executeJavaScript(readPreferences);
  await window.loadURL(uiURL);
  const current = await window.webContents.executeJavaScript(readPreferences);
  if (previous && current && previous.centerId !== current.centerId)
    throw new Error(
      "开发界面连接了不同中心；拒绝迁移偏好。请检查 Vite 的 API 代理。",
    );
  const entries = preferenceSeed(previous, current);
  if (entries.length) {
    await window.webContents.executeJavaScript(
      `for (const [key, value] of ${JSON.stringify(entries)}) localStorage.setItem(key, value)`,
    );
    await window.loadURL(uiURL);
  }
}

module.exports = {
  developmentOrigin,
  rendererURL,
  preferenceSeed,
  loadDevelopmentWindow,
};
