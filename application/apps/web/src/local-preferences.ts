import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
  applicationWindowKey,
  legacyApplicationWindowKey,
} from "../../../packages/core/src/application-names.js";

let localScope = "disconnected";

export function storageScope(centerId: string, principalId: string) {
  localScope = `${centerId}:${principalId}`;
}

export function readLocal<T>(key: string, fallback: T, scope = localScope): T {
  try {
    const suffix = scope + ":" + key;
    const raw =
      localStorage.getItem(applicationStoragePrefix + suffix) ??
      localStorage.getItem(legacyApplicationStoragePrefix + suffix);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Delivery identities must distinguish a missing record from unreadable data.
 * Existing presentation preferences deliberately retain their lenient reader. */
export function readLocalStrict(
  key: string,
  scope = localScope,
): { found: false } | { found: true; value: unknown } {
  const suffix = scope + ":" + key;
  const raw =
    localStorage.getItem(applicationStoragePrefix + suffix) ??
    localStorage.getItem(legacyApplicationStoragePrefix + suffix);
  return raw === null
    ? { found: false }
    : { found: true, value: JSON.parse(raw) as unknown };
}

export function writeLocal(key: string, value: unknown, scope = localScope) {
  localStorage.setItem(
    applicationStoragePrefix + scope + ":" + key,
    JSON.stringify(value),
  );
}

export function removeLocal(key: string, scope = localScope) {
  localStorage.removeItem(applicationStoragePrefix + scope + ":" + key);
  localStorage.removeItem(legacyApplicationStoragePrefix + scope + ":" + key);
}

/** Only clear matching delivery metadata in either supported prefix. Validate
 * every present copy before removing any; a hidden legacy attempt is not part
 * of a different canonical ACK. Storage is not a cross-window atomic CAS. */
export function removeLocalStrict(
  key: string,
  matches: (value: unknown) => boolean,
  scope = localScope,
): void {
  const keys = [applicationStoragePrefix, legacyApplicationStoragePrefix].map(
    (prefix) => prefix + scope + ":" + key,
  );
  const copies = keys.map((storageKey) => ({
    key: storageKey,
    raw: localStorage.getItem(storageKey),
  }));
  const changed = () =>
    new Error("本机重试记录已被另一操作修改，未清理该记录。");
  for (const copy of copies)
    if (copy.raw !== null && !matches(JSON.parse(copy.raw) as unknown))
      throw changed();
  for (const copy of copies)
    if (localStorage.getItem(copy.key) !== copy.raw) throw changed();
  for (const copy of copies) {
    if (localStorage.getItem(copy.key) !== copy.raw) throw changed();
    if (copy.raw !== null) localStorage.removeItem(copy.key);
  }
}

export function scopedStorage(scope = localScope) {
  return {
    readLocal: <T>(key: string, fallback: T) => readLocal(key, fallback, scope),
    readLocalStrict: (key: string) => readLocalStrict(key, scope),
    writeLocal: (key: string, value: unknown) => writeLocal(key, value, scope),
    removeLocal: (key: string) => removeLocal(key, scope),
    removeLocalStrict: (key: string, matches: (value: unknown) => boolean) =>
      removeLocalStrict(key, matches, scope),
  };
}

// Draft ownership is per window, so opening a second client does not overwrite
// an unsent input in the first one. The key survives a reload of that window.
export const draftOwner = (() => {
  try {
    const saved =
      sessionStorage.getItem(applicationWindowKey) ??
      sessionStorage.getItem(legacyApplicationWindowKey);
    const id = saved || crypto.randomUUID();
    sessionStorage.setItem(applicationWindowKey, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

/** A mutation retry key must survive this window's reload. The presentation
 * fallback above is not sufficient evidence that session storage persisted it. */
export function requirePersistentDraftOwner(): string {
  if (
    !draftOwner ||
    sessionStorage.getItem(applicationWindowKey) !== draftOwner
  )
    throw new Error("无法保存本窗口的安装重试标识，请恢复本机存储后重试。");
  return draftOwner;
}

export const draftKey = (key: string) => "draft:" + draftOwner + ":" + key;
