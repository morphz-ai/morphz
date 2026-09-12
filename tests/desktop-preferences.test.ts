import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  legacyOrigins,
  preferenceSeed,
} = require("../apps/desktop/preferences.cjs");
test("内嵌地址恢复保留原窗口草稿与幂等命令，只复制同中心同身份且优先当前旧地址", () => {
  const identity = { centerId: "center", principalId: "human" };
  const prefix = "morphzwork:center:human:";
  const pending = JSON.stringify({
    commandId: "stable-command",
    attachments: ["original-bytes"],
  });
  const seed = preferenceSeed(
    [
      [
        [prefix + "pending:message", pending],
        [prefix + "draft:window:conversation", "未发送"],
        [prefix + "desktop:last-window", "window"],
        ["morphzwork:other:human:draft", "other center"],
        ["auth", "never copied"],
      ],
      [
        [prefix + "draft:window:conversation", "outdated"],
        [prefix + "view", "original view"],
      ],
    ],
    identity,
  );
  assert.deepEqual(seed, {
    prefix: "morphz:center:human:",
    legacyPrefix: prefix,
    draftOwners: [],
    entries: [
      ["morphz:center:human:pending:message", pending],
      ["morphz:center:human:draft:window:conversation", "未发送"],
      ["morphz:center:human:desktop:last-window", "window"],
      ["morphz:center:human:view", "original view"],
    ],
  });
  assert.deepEqual(
    legacyOrigins([
      "--migrate-origin=http://127.0.0.1:65419",
      "--migrate-origin=http://127.0.0.1:65424",
    ]),
    ["http://127.0.0.1:65419", "http://127.0.0.1:65424"],
  );
  for (const origin of [
    "https://example.com",
    "http://localhost:65419",
    "http://127.0.0.1:65419/api",
    "http://user:secret@127.0.0.1:65419",
  ])
    assert.throws(() => legacyOrigins(["--migrate-origin=" + origin]));
});

test("旧版没有窗口标记时恢复唯一有内容的草稿，不在多个窗口之间猜测", () => {
  const identity = { centerId: "center", principalId: "human" };
  const prefix = "morphzwork:center:human:";
  const first = "12345678-1234-4234-9234-123456789abc";
  const second = "12345678-1234-4234-9234-123456789def";
  const entries: [string, string][] = [
    [
      prefix + `draft:${first}:inputs`,
      JSON.stringify({
        project: { body: "未发送", attachments: [{ assetId: "unchanged" }] },
      }),
    ],
    [
      prefix + `draft:${second}:inputs`,
      JSON.stringify({ project: { body: "   " } }),
    ],
  ];
  const one = preferenceSeed([entries], identity);
  assert.deepEqual(one.draftOwners, [first]);
  assert.equal(
    new Map(one.entries).get("morphz:center:human:desktop:last-window"),
    first,
  );
  assert.equal(
    new Map(one.entries).get(entries[0]![0].replace(/^morphzwork:/, "morphz:")),
    entries[0]![1],
  );
  entries[1]![1] = JSON.stringify({
    project: { selection: "另一个未提交的引用" },
  });
  const multiple = preferenceSeed([entries], identity);
  assert.deepEqual(multiple.draftOwners, [first, second]);
  assert.equal(
    new Map(multiple.entries).has("morphz:center:human:desktop:last-window"),
    false,
  );
});
