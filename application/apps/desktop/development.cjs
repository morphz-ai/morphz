const developmentOrigin = "http://127.0.0.1:65419";

function rendererURL(center, hot, packaged) {
  if (!hot) return center;
  if (packaged || center === developmentOrigin)
    throw new Error("热更新仅用于开发壳，且必须指定独立的应用服务地址。");
  return developmentOrigin;
}

// Developer-only transition to Vite. Never copy credentials or another identity.
const readPreferences = `(async () => {
  const response = await fetch('/api/workspace');
  if (!response.ok) return null;
  const boot = await response.json();
  if (typeof boot.centerId !== 'string' || typeof boot.principalId !== 'string') return null;
  const prefix = 'morphz:' + boot.centerId + ':' + boot.principalId + ':';
  const legacyPrefix = 'morphzwork:' + boot.centerId + ':' + boot.principalId + ':';
  return { centerId: boot.centerId, principalId: boot.principalId,
    entries: Object.entries(localStorage).filter(([key]) => key.startsWith(prefix) || key.startsWith(legacyPrefix)) };
})()`;

function preferenceSeed(previous, current) {
  if (
    !previous ||
    !current ||
    previous.centerId !== current.centerId ||
    previous.principalId !== current.principalId
  )
    return [];
  const prefix = `morphz:${current.centerId}:${current.principalId}:`;
  const legacyPrefix = `morphzwork:${current.centerId}:${current.principalId}:`;
  const normalize = (entries) => {
    const values = new Map();
    for (const sourcePrefix of [prefix, legacyPrefix])
      for (const [key, value] of entries) {
        if (
          typeof key !== "string" ||
          typeof value !== "string" ||
          !key.startsWith(sourcePrefix)
        )
          continue;
        const suffix = key.slice(sourcePrefix.length);
        if (/(?:^|:)(pending|pdf):/.test(suffix)) continue;
        const target = prefix + suffix;
        if (!values.has(target)) values.set(target, value);
      }
    return values;
  };
  const existing = normalize(current.entries);
  return [...normalize(previous.entries)].filter(([key]) => !existing.has(key));
}

async function loadDevelopmentWindow(window, center, uiURL) {
  await window.loadURL(center);
  const previous = await window.webContents.executeJavaScript(readPreferences);
  await window.loadURL(uiURL);
  const current = await window.webContents.executeJavaScript(readPreferences);
  if (previous && current && previous.centerId !== current.centerId)
    throw new Error(
      "开发界面连接了不同工作空间；拒绝迁移偏好。请检查 Vite 的 API 代理。",
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
