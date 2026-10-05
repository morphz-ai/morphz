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
