import test from "node:test";
import assert from "node:assert/strict";
import { migrateLegacyLocalState } from "../apps/web/src/legacy-storage.js";

test("旧单用户草稿只归属原中心；保留原值，不覆盖新值或迁移待执行命令", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const old = "morphzwork:draft:11111111-1111-4111-a111-111111111111:inputs";
  values.set(old, '{"first-project":"原草稿"}');
  values.set("morphzwork:preferences", '{"accent":"cyan"}');
  values.set(
    "morphzwork:draft:11111111-1111-4111-a111-111111111111:pending:abc",
    "secret-command",
  );
  const migrate = (
    center: string,
    actor: string,
    team: boolean,
    origin = "http://127.0.0.1:65420",
  ) => migrateLegacyLocalState(storage, center, actor, team, origin);
  migrate("team", "local-owner", true);
  migrate("x", "alpha", false);
  migrate("x", "local-owner", false, "http://127.0.0.1:65421");
  assert.equal(values.size, 3);
  migrate("original", "local-owner", false);
  const dest = old.replace("morphzwork:", "morphzwork:original:local-owner:");
  assert.equal(values.get(dest), values.get(old));
  assert.equal(values.size, 6);
  values.set(dest, "新草稿");
  migrate("original", "local-owner", false);
  assert.equal(values.get(dest), "新草稿");
  migrate("replacement", "local-owner", false);
  assert.equal(values.size, 6);
  assert.ok(values.has(old));
});
