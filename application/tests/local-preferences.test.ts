import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
} from "../packages/core/src/application-names.js";
import {
  draftKey,
  readLocal,
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
