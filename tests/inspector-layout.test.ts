import assert from "node:assert/strict";
import test from "node:test";
import { inspectorLayout } from "../apps/web/src/inspector-layout.js";

test("Host inspector reserves usable canvas and respects preferred width", () => {
  assert.deepEqual(inspectorLayout(1200, 356), {
    mode: "docked",
    width: 356,
    maxWidth: 520,
  });
  assert.equal(inspectorLayout(980, 520).width, 340);
  assert.equal(inspectorLayout(920, 520).width, 280);
  assert.equal(inspectorLayout(1200, 9999).width, 520);
  assert.equal(inspectorLayout(1200, -5).width, 280);
  assert.equal(inspectorLayout(1200, NaN).width, 340);
});

test("overlay is based on available workspace, not window breakpoint", () => {
  assert.equal(inspectorLayout(919).mode, "overlay");
  assert.equal(inspectorLayout(1000).mode, "docked");
  assert.equal(inspectorLayout(1000 - 228).mode, "overlay");
  assert.equal(inspectorLayout(760, 520).width, 340);
  assert.equal(inspectorLayout(300).width, 300);
  assert.equal(inspectorLayout(0).width, 0);
});
