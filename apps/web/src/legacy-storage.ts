type LocalStore = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

/** Adopt unscoped preferences/drafts from the original single-user center only.
 * Never import these into a team identity, another origin, or a replacement center.
 * Retain originals and never replace a newer scoped value. No commands are replayed.
 */
export function migrateLegacyLocalState(
  storage: LocalStore,
  centerId: string,
  principalId: string,
  teamAuthentication: boolean,
  origin: string,
) {
  if (
    teamAuthentication ||
    principalId !== "local-owner" ||
    origin !== "http://127.0.0.1:65420"
  )
    return;
  const claim = "morphzwork:legacy-center";
  try {
    const claimed = storage.getItem(claim);
    if (claimed && claimed !== centerId) return;
    storage.setItem(claim, centerId);
    const keys = Array.from({ length: storage.length }, (_, i) =>
      storage.key(i),
    );
    for (const key of keys) {
      if (!key?.startsWith("morphzwork:")) continue;
      const suffix = key.slice("morphzwork:".length);
      if (
        suffix !== "preferences" &&
        !/^pdf-page:[a-zA-Z0-9_-]+$/.test(suffix) &&
        !/^draft:[0-9a-f-]{36}:(inputs|edit:[a-zA-Z0-9_-]+)$/.test(suffix)
      )
        continue;
      const target = `morphzwork:${centerId}:${principalId}:${suffix}`;
      if (storage.getItem(target) !== null) continue;
      const value = storage.getItem(key);
      if (value !== null) storage.setItem(target, value);
    }
  } catch {
    // Read-only/full local storage must not prevent opening the authoritative center.
  }
}

/** Adopt only the authenticated center/principal's old names, byte for byte. */
export function migrateApplicationLocalState(
  storage: LocalStore,
  centerId: string,
  principalId: string,
) {
  const scope = `${centerId}:${principalId}:`;
  const previous = legacyApplicationStoragePrefix + scope;
  const current = applicationStoragePrefix + scope;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    );
    for (const key of keys) {
      if (!key?.startsWith(previous)) continue;
      const next = current + key.slice(previous.length);
      if (storage.getItem(next) !== null) continue;
      const value = storage.getItem(key);
      if (value !== null) storage.setItem(next, value);
    }
  } catch {
    // Originals stay intact when storage is unavailable/full. readLocal still
    // supports the old name; never replay a pending command as part of migration.
  }
}
import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
} from "../../../packages/core/src/application-names.js";
