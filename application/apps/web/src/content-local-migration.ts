import { applicationStoragePrefix } from "../../../packages/core/src/application-names.js";

type LocalStore = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

/** Correct old project-dependent draft keys once. Runtime reads only stable
 * content identity afterward; originals are retained as recovery data, not aliases. */
export function migrateContentLocalState(
  storage: LocalStore,
  centerId: string,
  principalId: string,
) {
  const scope = `${applicationStoragePrefix}${centerId}:${principalId}:`;
  const marker = scope + "content-draft-identity-v1";
  try {
    if (storage.getItem(marker)) return;
    const keys = Array.from({ length: storage.length }, (_, i) =>
      storage.key(i),
    );
    for (const key of keys) {
      if (!key?.startsWith(scope)) continue;
      const match =
        /^(draft:[a-zA-Z0-9_-]+:script:)[a-zA-Z0-9_-]+:([a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:(?:base|v\d+))$/.exec(
          key.slice(scope.length),
        );
      if (!match) continue;
      const next = scope + match[1] + match[2];
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null)
        storage.setItem(next, value);
    }
    storage.setItem(marker, "1");
  } catch {
    // Do not mark complete on storage failure. Existing drafts are untouched.
  }
}
