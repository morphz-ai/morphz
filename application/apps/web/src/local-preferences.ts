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

export function scopedStorage(scope = localScope) {
  return {
    readLocal: <T>(key: string, fallback: T) => readLocal(key, fallback, scope),
    writeLocal: (key: string, value: unknown) => writeLocal(key, value, scope),
    removeLocal: (key: string) => removeLocal(key, scope),
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

export const draftKey = (key: string) => "draft:" + draftOwner + ":" + key;
