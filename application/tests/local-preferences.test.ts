import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
  applicationWindowKey,
} from "../packages/core/src/application-names.js";
import {
  draftKey,
  draftOwner,
  readLocal,
  readLocalStrict,
  requirePersistentDraftOwner,
  scopedStorage,
  storageScope,
  writeLocal,
} from "../apps/web/src/local-preferences.js";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("Platform 客户端偏好按身份隔离，未发送草稿仍按窗口归属", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    storageScope("center-a", "human-a");
    const a = scopedStorage();
    a.writeLocal("view", { name: "项目 A" });
    assert.deepEqual(a.readLocal("view", null), { name: "项目 A" });
    storageScope("center-a", "human-b");
    assert.equal(readLocal("view", null), null);
    writeLocal("view", { name: "项目 B" });
    assert.deepEqual(a.readLocal("view", null), { name: "项目 A" });
    assert.equal(
      storage.getItem(`${applicationStoragePrefix}center-a:human-b:view`),
      JSON.stringify({ name: "项目 B" }),
    );
    storage.setItem(
      `${legacyApplicationStoragePrefix}center-a:human-b:older`,
      JSON.stringify({ saved: true }),
    );
    assert.deepEqual(readLocal("older", null), { saved: true });
    assert.equal(draftKey("inputs"), draftKey("inputs"));
    assert.notEqual(draftKey("inputs"), draftKey("conversations"));
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    storageScope("disconnected", "anonymous");
  }
});

test("strict delivery reads preserve absence, stored null and legacy values", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const owner = scopedStorage("center:human");
    assert.deepEqual(owner.readLocalStrict("retry"), { found: false });
    storage.setItem(`${applicationStoragePrefix}center:human:retry`, "null");
    assert.deepEqual(owner.readLocalStrict("retry"), {
      found: true,
      value: null,
    });
    storage.removeItem(`${applicationStoragePrefix}center:human:retry`);
    storage.setItem(
      `${legacyApplicationStoragePrefix}center:human:retry`,
      '{"commandId":"old"}',
    );
    storageScope("other", "human");
    assert.deepEqual(owner.readLocalStrict("retry"), {
      found: true,
      value: { commandId: "old" },
    });
    assert.deepEqual(readLocalStrict("retry", "other:human"), { found: false });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    storageScope("disconnected", "anonymous");
  }
});

test("strict delivery reads fail closed on malformed bytes and storage failure", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    for (const bytes of ["", "{broken", "undefined"]) {
      storage.setItem(`${applicationStoragePrefix}center:human:retry`, bytes);
      assert.throws(
        () => readLocalStrict("retry", "center:human"),
        SyntaxError,
      );
      assert.equal(readLocal("retry", "fallback", "center:human"), "fallback");
    }
    storage.getItem = () => {
      throw new Error("storage unavailable");
    };
    assert.throws(
      () => readLocalStrict("retry", "center:human"),
      /storage unavailable/,
    );
    assert.equal(readLocal("retry", "fallback", "center:human"), "fallback");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("durable delivery requires the actual existing window owner without rewriting it", () => {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    assert.throws(() => requirePersistentDraftOwner(), /重试标识/);
    assert.equal(storage.length, 0);
    storage.setItem(applicationWindowKey, "another-window");
    assert.throws(() => requirePersistentDraftOwner(), /重试标识/);
    assert.equal(storage.getItem(applicationWindowKey), "another-window");
    storage.setItem(applicationWindowKey, draftOwner);
    assert.equal(requirePersistentDraftOwner(), draftOwner);
    storage.getItem = () => {
      throw new Error("window storage unavailable");
    };
    assert.throws(
      () => requirePersistentDraftOwner(),
      /window storage unavailable/,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("strict cleanup validates both prefixes before removal, retaining hidden foreign attempts", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  const canonical = `${applicationStoragePrefix}center:human:retry`;
  const legacy = `${legacyApplicationStoragePrefix}center:human:retry`;
  const own = scopedStorage("center:human");
  const match = (value: unknown) =>
    JSON.stringify(value) === '{"id":"original"}';
  try {
    own.removeLocalStrict("retry", match);
    for (const foreign of ['{"id":"other"}', "null", "{broken"]) {
      storage.setItem(canonical, '{"id":"original"}');
      storage.setItem(legacy, foreign);
      assert.throws(() => own.removeLocalStrict("retry", match));
      assert.equal(storage.getItem(canonical), '{"id":"original"}');
      assert.equal(storage.getItem(legacy), foreign);
    }
    storage.setItem(legacy, '{"id":"original"}');
    storage.setItem(
      `${applicationStoragePrefix}other:human:retry`,
      '{"id":"other"}',
    );
    storageScope("other", "human");
    own.removeLocalStrict("retry", match);
    assert.equal(storage.getItem(canonical), null);
    assert.equal(storage.getItem(legacy), null);
    assert.equal(
      storage.getItem(`${applicationStoragePrefix}other:human:retry`),
      '{"id":"other"}',
    );
    storage.setItem(legacy, '{"id":"original"}');
    own.removeLocalStrict("retry", match);
    assert.equal(storage.getItem(legacy), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    storageScope("disconnected", "anonymous");
  }
});

test("strict cleanup rechecks original bytes and surfaces IO failures without clearing a replacement", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  const key = `${applicationStoragePrefix}center:human:retry`;
  const legacy = `${legacyApplicationStoragePrefix}center:human:retry`;
  const own = scopedStorage("center:human");
  try {
    storage.setItem(key, '{"id":"original"}');
    assert.throws(
      () =>
        own.removeLocalStrict("retry", () => {
          storage.setItem(key, '{"id":"replacement"}');
          return true;
        }),
      /另一操作/,
    );
    assert.equal(storage.getItem(key), '{"id":"replacement"}');
    storage.setItem(key, '{"id":"original"}');
    storage.setItem(legacy, '{"id":"original"}');
    const originalRemove = storage.removeItem.bind(storage);
    storage.removeItem = (storageKey) => {
      if (storageKey === legacy) throw new Error("cleanup unavailable");
      originalRemove(storageKey);
    };
    assert.throws(
      () => own.removeLocalStrict("retry", () => true),
      /cleanup unavailable/,
    );
    assert.equal(storage.getItem(key), null);
    assert.equal(storage.getItem(legacy), '{"id":"original"}');
    storage.getItem = () => {
      throw new Error("read unavailable");
    };
    assert.throws(
      () => own.removeLocalStrict("retry", () => true),
      /read unavailable/,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
