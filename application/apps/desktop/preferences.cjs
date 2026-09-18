const restorePath = "/__desktop_restore";
const emptyPage = () =>
  new Response("<!doctype html><meta charset=utf-8><title>Morphz</title>", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "no-store",
    },
  });

function legacyOrigins(args) {
  const values = args
    .filter((arg) => arg.startsWith("--migrate-origin="))
    .map((arg) => arg.slice(17));
  if (values.length > 5) throw new Error("旧界面地址过多。");
  return [
    ...new Set(
      values.length
        ? values
        : ["http://127.0.0.1:65420", "http://127.0.0.1:65419"],
    ),
  ].map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      Number(url.port) < 1024 ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("只能恢复明确的旧本机界面地址。");
    return url.origin;
  });
}
function preferenceSeed(previous, identity) {
  const prefix = `morphz:${identity.centerId}:${identity.principalId}:`;
  const legacyPrefix = `morphzwork:${identity.centerId}:${identity.principalId}:`;
  const merged = new Map();
  for (const entries of previous)
    for (const sourcePrefix of [prefix, legacyPrefix])
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [key, value] = pair;
        if (
          typeof key !== "string" ||
          typeof value !== "string" ||
          !key.startsWith(sourcePrefix)
        )
          continue;
        const target = prefix + key.slice(sourcePrefix.length);
        if (!merged.has(target)) merged.set(target, value);
      }
  // Older builds did not persist a current-window marker. Recover the sole
  // window with real unsent content; never choose arbitrarily between drafts.
  const owners = new Set();
  for (const [key, value] of merged) {
    const match = /^draft:([a-f0-9-]{36}):inputs$/.exec(
      key.slice(prefix.length),
    );
    if (!match) continue;
    try {
      if (
        Object.values(JSON.parse(value)).some(
          (draft) =>
            draft &&
            (draft.body?.trim() ||
              draft.selection?.trim() ||
              draft.attachments?.length),
        )
      )
        owners.add(match[1]);
    } catch {}
  }
  if (!merged.has(prefix + "desktop:last-window") && owners.size === 1)
    merged.set(prefix + "desktop:last-window", [...owners][0]);
  return {
    prefix,
    legacyPrefix,
    entries: [...merged],
    draftOwners: [...owners],
  };
}

// Read only Chromium's existing origin storage. An in-process blank response
// prevents fetching/running the old application or contacting any old server.
async function collectLegacyPreferences(
  BrowserWindow,
  appSession,
  origins,
  identity,
) {
  const reader = new BrowserWindow({
    show: false,
    webPreferences: {
      session: appSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const values = [];
  appSession.protocol.handle("http", (request) =>
    origins.includes(new URL(request.url).origin)
      ? emptyPage()
      : new Response("Forbidden", { status: 403 }),
  );
  try {
    for (const origin of origins) {
      await reader.loadURL(origin + "/");
      values.push(
        await reader.webContents.executeJavaScript(
          "Object.entries(localStorage)",
        ),
      );
    }
    return preferenceSeed(values, identity);
  } finally {
    appSession.protocol.unhandle("http");
    reader.destroy();
  }
}

async function restorePreferences(window, seed) {
  await window.loadURL("morphz://app" + restorePath);
  return window.webContents.executeJavaScript(`(() => {
    const seed = ${JSON.stringify(seed)};
    let restored = 0;
    // Same-origin old names take priority over older HTTP-origin seed data.
    // Copy raw values only within this authenticated scope, never remove sources.
    const legacyPrefix = seed.legacyPrefix || seed.prefix.replace(/^morphz:/, 'morphzwork:');
    for (const [key, value] of Object.entries(localStorage)) {
      if (!key.startsWith(legacyPrefix)) continue;
      const target = seed.prefix + key.slice(legacyPrefix.length);
      if (localStorage.getItem(target) === null) { localStorage.setItem(target, value); restored++; }
    }
    for (const [key, value] of seed.entries) {
      if (localStorage.getItem(key) === null) { localStorage.setItem(key, value); restored++; }
    }
    let owner = localStorage.getItem(seed.prefix + 'desktop:last-window');
    const previous = seed.entries.find(([key]) => key === seed.prefix + 'desktop:last-window')?.[1];
    let currentHasDraft = false;
    try { currentHasDraft = Object.values(JSON.parse(localStorage.getItem(seed.prefix + 'draft:' + owner + ':inputs') || '{}')).some(draft => draft && (draft.body?.trim() || draft.selection?.trim() || draft.attachments?.length)); } catch {}
    if (!currentHasDraft && seed.draftOwners?.length === 1 && previous === seed.draftOwners[0]) {
      owner = previous;
      localStorage.setItem(seed.prefix + 'desktop:last-window', owner);
    }
    if (!sessionStorage.getItem('morphz:window')) {
      const existing = sessionStorage.getItem('morphzwork:window');
      const selected = existing || owner;
      if (selected && /^[a-f0-9-]{36}$/.test(selected)) sessionStorage.setItem('morphz:window', selected);
    }
    return { restored, ownerRestored: !!owner, owner, draftOwners: seed.draftOwners || [] };
  })()`);
}
module.exports = {
  restorePath,
  emptyPage,
  legacyOrigins,
  preferenceSeed,
  collectLegacyPreferences,
  restorePreferences,
};
