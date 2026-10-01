import test from "node:test";
import assert from "node:assert/strict";
import { parseApplicationViewState } from "../packages/core/src/applications.js";

test("剧本精确定位仅属于剧本窗口，其他应用不接收错误的领域导航", () => {
  const state = {
    scriptTarget: {
      productionId: "script-one",
      itemId: "scene-one",
      revision: 2,
    },
  };
  assert.deepEqual(
    parseApplicationViewState("morphz.script-studio", state),
    state,
  );
  for (const appId of [
    "morphz.objects",
    "morphz.reader",
    "morphz.browser",
    "example.scratchpad",
  ])
    for (const wrong of [
      state,
      { productionId: "script-one" },
      { itemId: "scene-one" },
    ])
      assert.throws(() => parseApplicationViewState(appId, wrong));
  assert.deepEqual(
    parseApplicationViewState("morphz.objects", {
      artifactId: "document-one",
      view: "editor",
    }),
    { artifactId: "document-one", view: "editor" },
  );
  assert.deepEqual(
    parseApplicationViewState("morphz.reader", { artifactId: "book-one" }),
    { artifactId: "book-one" },
  );
  assert.deepEqual(
    parseApplicationViewState("morphz.browser", {
      url: "https://example.invalid/",
    }),
    { url: "https://example.invalid/" },
  );
});
