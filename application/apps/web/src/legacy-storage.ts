type LocalStore = Pick<Storage, "length" | "key" | "getItem" | "setItem">;
import { removeReadingPolicyFields } from "../../../packages/core/src/reading-policy-migration.js";

/** Remove retired reading options from this identity's unsent drafts once. */
export function migrateReadingLocalState(
  storage: LocalStore,
  centerId: string,
  principalId: string,
) {
  const scope = `${applicationStoragePrefix}${centerId}:${principalId}:`;
  const marker = scope + "reading-policy-cleanup-v1";
  try {
    if (storage.getItem(marker)) return;
    const keys = Array.from({ length: storage.length }, (_, i) =>
      storage.key(i),
    );
    for (const key of keys) {
      if (
        !key?.startsWith(scope + "draft:") ||
        !/:(inputs|discarded-conversations)$/.test(key)
      )
        continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw);
      let changed = false;
      const drafts = key.endsWith(":inputs")
        ? Object.values(value)
        : Object.values(value).flatMap((entry: any) =>
            Object.values(entry.drafts ?? {}),
          );
      for (const draft of drafts as { reading?: unknown }[])
        changed = removeReadingPolicyFields(draft.reading) || changed;
      if (changed) storage.setItem(key, JSON.stringify(value));
    }
    storage.setItem(marker, "1");
  } catch {
    // Never erase an unreadable draft or mark an interrupted cleanup complete.
  }
}

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
